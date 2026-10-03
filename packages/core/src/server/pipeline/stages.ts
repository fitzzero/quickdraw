// The pipeline stages before the handler runs (RFC 0003 section 9, steps 1
// to 5): look the method up, take a query slot, start the call's time limit,
// build the context, and ask for the result's current version.

import type { Version } from "../../protocol/envelope";
import { QuickdrawError } from "../../protocol/errors";
import { createContext, NEVER_ABORTED, type AnyContext } from "../context";
import type { RegisteredMethod, Registry } from "../registry";
import { runtimeOf } from "../service";
import type { QuerySlot, ConcurrencyLimiter } from "./concurrency";
import { abortError, timeoutError } from "./errors";
import { isVersion } from "./notModified";
import type { DispatchRequest } from "./request";
import type { PipelineSettings } from "./settings";

/** Step 1: the method a call names, or `NOT_FOUND`. */
export function lookup(registry: Registry, request: DispatchRequest): RegisteredMethod {
  const found = registry.find(request.service, request.method);
  if (found !== undefined) {
    return found;
  }
  const message = registry.services.has(request.service)
    ? `Unknown method "${request.method}" on service "${request.service}"`
    : `Unknown service "${request.service}"`;
  throw new QuickdrawError("NOT_FOUND", message);
}

/**
 * Step 2: a query slot on the call's connection. Mutations and calls without
 * a connection are not capped, so they get no slot.
 */
export function admit(
  limiter: ConcurrencyLimiter,
  request: DispatchRequest,
  target: RegisteredMethod,
  signal: AbortSignal | undefined,
): Promise<QuerySlot | undefined> {
  if (target.method.kind !== "query" || request.connectionId === undefined) {
    return Promise.resolve(undefined);
  }
  return limiter.acquire(request.connectionId, signal);
}

/** A call's time limit, from {@link startTimeLimit}. */
export interface TimeLimit {
  /** Aborts when the caller cancels (a query) or the time limit passes. */
  readonly signal: AbortSignal;
  /** Aborts when the time limit passes, with the call's `TIMEOUT` error as its reason. */
  readonly expired: AbortSignal;
  /** Stops the clock. */
  stop(): void;
}

/**
 * Starts a call's time limit (RFC 0003 section 9, step 7) once the call is
 * admitted, so it covers every stage after step 2: validation, the access
 * check, `version()`, the handler and the output check. Time spent waiting
 * for a query slot does not count. `cancel` is the caller's own signal,
 * which only a query has.
 */
export function startTimeLimit(timeoutMs: number, cancel: AbortSignal | undefined): TimeLimit {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(timeoutError(timeoutMs)), timeoutMs);
  return {
    signal: cancel === undefined ? controller.signal : AbortSignal.any([cancel, controller.signal]),
    expired: controller.signal,
    stop: () => clearTimeout(timer),
  };
}

/**
 * Waits for `work`, or rejects as soon as `signal` aborts: with `TIMEOUT`
 * when the call's time limit aborted it, and `CANCELLED` otherwise. `work`
 * keeps running; its late result is ignored.
 */
export function untilStopped<T>(work: PromiseLike<T>, signal: AbortSignal | undefined): Promise<T> {
  if (signal === undefined) {
    return Promise.resolve(work);
  }
  return new Promise<T>((resolve, reject) => {
    const onAbort = (): void => reject(abortError(signal));
    if (signal.aborted) {
      onAbort();
    }
    signal.addEventListener("abort", onAbort, { once: true });
    work.then(
      (value) => {
        signal.removeEventListener("abort", onAbort);
        resolve(value);
      },
      (error: unknown) => {
        signal.removeEventListener("abort", onAbort);
        reject(error);
      },
    );
  });
}

/** The context of one call: the framework's fields, then the app's from `initQuickdraw({ context })`. */
export function contextFor(
  settings: PipelineSettings,
  request: DispatchRequest,
  requestId: string,
  target: RegisteredMethod,
  signal: AbortSignal | undefined,
): AnyContext {
  const log = settings.logger.child({
    service: target.service.name,
    method: target.method.name,
    requestId,
  });
  const fields = {
    principal: request.principal,
    signal: signal ?? NEVER_ABORTED,
    log,
    requestId,
    transport: request.transport,
    ...(request.mcp === undefined ? {} : { mcp: request.mcp }),
    touch: settings.touch,
  };
  return createContext(fields, runtimeOf(target.service)?.extendContext);
}

/**
 * Step 5: the current version of a query's result, from the method's own
 * `version`, or else the dispatcher's `versions` source. Mutations have none.
 */
export async function currentVersion(
  settings: PipelineSettings,
  target: RegisteredMethod,
  input: unknown,
  ctx: AnyContext,
): Promise<Version | undefined> {
  const { service, method } = target;
  if (method.kind !== "query") {
    return undefined;
  }
  const version =
    method.version === undefined
      ? await settings.versions?.versionOf({ service, method, input, ctx })
      : await method.version(input, ctx);
  return isVersion(version) ? version : undefined;
}
