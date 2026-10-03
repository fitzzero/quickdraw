// The pipeline stages that run the handler (RFC 0003 section 9, steps 6 to
// 8): join an identical run in flight when the query shares, otherwise start
// one inside a unit of work, then check the result against the contract.

import { QuickdrawError } from "../../protocol/errors";
import { withSignal, type AnyContext } from "../context";
import type { RegisteredMethod } from "../registry";
import type { Transport } from "../types";
import { startRun, type Outcome, type Run } from "./run";
import { deepFreeze, shareKey, type ShareTable } from "./share";
import type { PipelineSettings } from "./settings";
import { outputIssues } from "./validation";

/** What `execute` needs to know about the call, and what it reports back. */
export interface ExecuteCall {
  readonly requestId: string;
  readonly transport: Transport;
  readonly principal: AnyContext["principal"];
  /** Aborts when the caller cancels; `undefined` for a mutation, which cannot be cancelled. */
  readonly signal: AbortSignal | undefined;
  /** Set when the result came from another call's run. */
  shared: boolean;
  /** Set when this call started the run, and so flushes it. */
  run: Run | undefined;
}

/** Step 8: checks the handler's value against the method's output, and freezes shared results. */
async function accept(
  settings: PipelineSettings,
  target: RegisteredMethod,
  value: unknown,
): Promise<Outcome> {
  const { service, method } = target;
  if (settings.outputValidation) {
    const issues = await outputIssues(method.output, value);
    if (issues !== undefined) {
      const error = new QuickdrawError(
        "INTERNAL",
        `${service.name}.${method.name} returned a value that does not match its contract output`,
        { issues },
      );
      return { ok: false, error };
    }
  }
  const freeze = method.share !== undefined && settings.freezeSharedResults;
  return { ok: true, value: freeze ? deepFreeze(value) : value };
}

/** Steps 6 to 8 for one authorized call with its parsed input. */
export function execute(
  settings: PipelineSettings,
  shares: ShareTable<Run>,
  target: RegisteredMethod,
  call: ExecuteCall,
  input: unknown,
  ctx: AnyContext,
): Promise<Outcome> {
  const { service, method } = target;
  const key =
    method.share === undefined
      ? undefined
      : shareKey(
          service.name,
          method.name,
          method.share === "all" ? "*" : call.principal,
          input,
          ctx.mcp,
        );
  const existing = key === undefined ? undefined : shares.get(key);
  if (existing !== undefined && existing.settled?.ok !== false) {
    call.shared = true;
    return existing.join(call.signal);
  }
  const unit = settings.unitOfWork.begin({
    service: service.name,
    method: method.name,
    kind: method.kind,
    requestId: call.requestId,
    transport: call.transport,
    sink: settings.flushSink,
  });
  const run = startRun({
    timeoutMs: method.timeoutMs ?? settings.limits.callTimeoutMs,
    unit,
    invoke: (signal) => method.handler({ input, ctx: withSignal(ctx, signal), db: settings.db }),
    accept: (value) => accept(settings, target, value),
  });
  call.run = run;
  if (key !== undefined) {
    shares.add(key, run, method.ttlMs);
  }
  return run.join(call.signal);
}
