// The method pipeline: the one path every call takes, whatever transport it
// arrived on (RFC 0003 section 9). It replaces 4.1's per-method socket
// listener (`legacy-src/server/ServiceRegistry.ts:271-407`):
//
//   1. look up the method                       NOT_FOUND
//   2. take a query slot on the connection      RATE_LIMITED, CANCELLED
//   3. validate the input                       VALIDATION
//   4. authorize                                UNAUTHENTICATED, FORBIDDEN
//   5. answer "not modified" when the caller's version is current
//   6. join an identical shared run in flight
//   7. run the handler in a unit of work        TIMEOUT, CANCELLED
//   8. check the output against the contract    INTERNAL
//   9. respond, flush, and emit one completion record
//
// A query's cancel signal answers the caller at once, and so does the time
// limit, while work already started (a slow access check, a handler that
// ignores its signal) runs on unanswered. A query keeps its slot until that
// work has settled, so a connection never runs more of it than its cap.

import { createConcurrencyLimiter, type ConcurrencyLimiter, type QuerySlot } from "./concurrency";
import { throwIfCancelled, toQuickdrawError } from "./errors";
import { execute, type ExecuteCall } from "./execute";
import { describeError, type CallOutcome, type CallRecord } from "./metrics";
import type { DispatchRequest, DispatchResult } from "./request";
import type { Run } from "./run";
import type { PipelineSettings } from "./settings";
import { createShareTable, type ShareTable } from "./share";
import { admit, contextFor, currentVersion, lookup, untilCancelled } from "./stages";
import { parseInput } from "./validation";

/** Runs one call through the pipeline. Resolves once the reply was sent, flushed and recorded; never rejects. */
export type Dispatch = (request: DispatchRequest) => Promise<DispatchResult>;

interface Pipeline {
  readonly settings: PipelineSettings;
  readonly limiter: ConcurrencyLimiter;
  readonly shares: ShareTable<Run>;
}

interface CallState extends ExecuteCall {
  readonly request: DispatchRequest;
  signal: AbortSignal | undefined;
  kind: CallRecord["kind"];
  queueMs: number;
  /** The work of the stage the call is in, or last finished. It may outlive the call's answer. */
  stageWork: Promise<unknown> | undefined;
}

/**
 * One of steps 3 to 5: waits for `work` until the call is cancelled, and
 * keeps it as the call's stage work.
 */
function stage<T>(call: CallState, work: T | PromiseLike<T>): Promise<T> {
  const running = Promise.resolve(work);
  call.stageWork = running;
  return untilCancelled(running, call.signal);
}

/** Steps 3 to 8, for a call that has its method and, for a query, its slot. */
async function proceed(
  pipeline: Pipeline,
  call: CallState,
  target: ReturnType<typeof lookup>,
): Promise<DispatchResult> {
  const { settings } = pipeline;
  const { request } = call;
  const label = `${target.service.name}.${target.method.name}`;
  const input = await stage(call, parseInput(target.method.input, request.input, label));
  const ctx = contextFor(settings, request, call.requestId, target, call.signal);
  const access = {
    service: target.service,
    method: target.method.name,
    principal: request.principal,
    input,
    ctx,
  };
  await stage(call, settings.access.authorize(target.method.access, access));
  const version = await stage(call, currentVersion(settings, target, input, ctx));
  if (version !== undefined && request.v === version) {
    return { ok: true, notModified: true, version };
  }
  const outcome = await execute(settings, pipeline.shares, target, call, input, ctx);
  if (!outcome.ok) {
    return { ok: false, error: outcome.error };
  }
  return version === undefined
    ? { ok: true, data: outcome.value }
    : { ok: true, data: outcome.value, version };
}

/**
 * Frees a query's slot once nothing the call started is still running: the
 * stage it was answered in the middle of, or the handler run it started.
 */
function release(call: CallState, slot: QuerySlot | undefined): void {
  if (slot === undefined) {
    return;
  }
  const running = call.run === undefined ? call.stageWork : call.run.handlerDone;
  if (running === undefined) {
    slot.release();
    return;
  }
  void running.then(slot.release, slot.release);
}

/** Steps 1 to 8. Every failure becomes a result; the slot is freed however the call ends. */
async function settle(pipeline: Pipeline, call: CallState): Promise<DispatchResult> {
  let slot: QuerySlot | undefined;
  try {
    const target = lookup(pipeline.settings.registry, call.request);
    call.kind = target.method.kind;
    call.signal = target.method.kind === "query" ? call.request.signal : undefined;
    throwIfCancelled(call.signal);
    slot = await admit(pipeline.limiter, call.request, target, call.signal);
    call.queueMs = slot?.queueMs ?? 0;
    return await proceed(pipeline, call, target);
  } catch (error) {
    return { ok: false, error: toQuickdrawError(error) };
  } finally {
    release(call, slot);
  }
}

/** Step 9a: hands the result to the transport, which reports the reply's size. */
function respond(settings: PipelineSettings, call: CallState, result: DispatchResult): number {
  const { respond: send } = call.request;
  if (send === undefined) {
    return 0;
  }
  try {
    const bytes = send(result);
    return typeof bytes === "number" && Number.isFinite(bytes) && bytes > 0 ? bytes : 0;
  } catch (error) {
    settings.logger.error("A transport failed to send a reply", {
      category: "quickdraw.call",
      requestId: call.requestId,
      error: describeError(error),
    });
    return 0;
  }
}

/**
 * Step 9b: flushes the run this call started, once its handler has settled.
 * A handler still running after `TIMEOUT` or `CANCELLED` is flushed when it
 * settles, without holding up this call.
 */
async function flushRun(settings: PipelineSettings, call: CallState): Promise<void> {
  const { run } = call;
  if (run === undefined) {
    return;
  }
  const flush = async (): Promise<void> => {
    try {
      await run.unit.flush();
    } catch (error) {
      settings.logger.error("Flushing a call's writes failed; its reply was already sent", {
        category: "quickdraw.call",
        requestId: call.requestId,
        error: describeError(error),
      });
    }
  };
  if (run.handlerSettled) {
    await flush();
    return;
  }
  void run.handlerDone.then(flush);
}

function outcomeOf(result: DispatchResult): CallOutcome {
  if (!result.ok) {
    return result.error.code;
  }
  return result.notModified === true ? "not-modified" : "ok";
}

function recordOf(
  call: CallState,
  result: DispatchResult,
  durationMs: number,
  bytes: number,
): CallRecord {
  const { request } = call;
  return {
    service: request.service,
    method: request.method,
    kind: call.kind,
    transport: request.transport,
    requestId: call.requestId,
    outcome: outcomeOf(result),
    durationMs,
    queueMs: call.queueMs,
    bytes,
    shared: call.shared,
    sqlStatements: call.run?.unit.sqlStatements,
  };
}

/** Builds the pipeline's `Dispatch` function over the resolved settings. */
export function createPipeline(settings: PipelineSettings): Dispatch {
  const pipeline: Pipeline = {
    settings,
    limiter: createConcurrencyLimiter({
      maxInFlight: settings.limits.maxInFlightQueries,
      maxQueued: settings.limits.maxQueuedQueries,
      retryAfterMs: settings.limits.retryAfterMs,
    }),
    shares: createShareTable<Run>(),
  };
  return async (request) => {
    const startedAt = performance.now();
    const call: CallState = {
      request,
      requestId: request.requestId ?? crypto.randomUUID(),
      transport: request.transport,
      principal: request.principal,
      signal: undefined,
      kind: undefined,
      queueMs: 0,
      stageWork: undefined,
      shared: false,
      run: undefined,
    };
    const result = await settle(pipeline, call);
    const durationMs = performance.now() - startedAt;
    const bytes = respond(settings, call, result);
    await flushRun(settings, call);
    settings.record(recordOf(call, result, durationMs, bytes), {
      error: result.ok ? undefined : result.error,
      userId: request.principal?.userId,
    });
    return result;
  };
}
