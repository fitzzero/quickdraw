// The pipeline stages that run the handler (RFC 0003 section 9, steps 6 to
// 8): join an identical run in flight when the query shares, otherwise start
// one inside a unit of work, then project a projection output's rows, or
// reduce a schema output to what its schema declares (`schemaOutput.ts`),
// and check the result against the contract. Field tiers are stripped later,
// per caller (`tiers.ts`), because a shared run's result goes to every
// caller; callers who see the same fields share one copy (`replies.ts`).

import { QuickdrawError } from "../../protocol/errors";
import { NEVER_ABORTED, withSignal, type AnyContext } from "../context";
import { projectOutput } from "../emit/projection";
import { warnTieredReply } from "../emit/tieredOutputs";
import type { RegisteredMethod } from "../registry";
import { isKitHandler } from "../service";
import { startRun, type Outcome, type Run } from "./run";
import { deepFreeze, shareKey, type ShareTable } from "./share";
import type { PipelineSettings } from "./settings";
import { outputIssues } from "./validation";

export { forCaller } from "./replies";

/** What `execute` needs to know about the call, and what it reports back. */
export interface ExecuteCall {
  readonly requestId: string;
  readonly transport: AnyContext["transport"];
  readonly principal: AnyContext["principal"];
  /**
   * Aborts when the caller cancels (a query; a mutation cannot be cancelled)
   * or the call's time limit passes. The call then leaves the run it joined.
   */
  readonly signal: AbortSignal | undefined;
  /** Aborts when the call's time limit passes. A run this call starts ends with it. */
  readonly expired: AbortSignal | undefined;
  /** Set when the result came from another call's run. */
  shared: boolean;
  /** Set when this call started the run, and so flushes it. */
  run: Run | undefined;
  /** The shared run this call takes its result from, started or joined; unset when it runs unshared. */
  source: Run | undefined;
}

/** The handler's result in the shape its output sends: a projection's rows, or what a schema declares. */
function shaped(target: RegisteredMethod, returned: unknown): unknown {
  const { projection, schemaOutput } = target.method;
  if (projection !== undefined) {
    return projectOutput(projection, returned);
  }
  return schemaOutput === undefined ? returned : schemaOutput.pick(returned);
}

/**
 * Step 8: projects a projection output's rows (RFC 0003 section 6: the
 * projection's keys only, dates as ISO strings) or reduces a schema output
 * to what its schema declares (`schemaOutput.ts`), on every transport and
 * whatever `outputValidation` is; checks the result against the method's
 * output, and freezes shared results.
 */
async function accept(
  settings: PipelineSettings,
  target: RegisteredMethod,
  returned: unknown,
): Promise<Outcome> {
  const { service, method } = target;
  const value = shaped(target, returned);
  if (settings.warnings.enabled) {
    warnTieredReply(target, value, settings.warnings);
  }
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
          method.share === "all"
            ? "*"
            : { principal: call.principal, transport: call.transport, mcp: ctx.mcp },
          input,
        );
  const existing = key === undefined ? undefined : shares.get(key);
  if (existing !== undefined && existing.settled?.ok !== false) {
    call.shared = true;
    call.source = existing;
    return existing.join(call.signal);
  }
  const unit = settings.unitOfWork.begin({
    service: service.name,
    method: method.name,
    kind: method.kind,
    requestId: call.requestId,
    transport: call.transport,
    sink: settings.flushSink,
    warnings: settings.warnings,
  });
  const run = startRun({
    // The pipeline starts every call's time limit at admission, before this.
    timeLimit: call.expired ?? NEVER_ABORTED,
    unit,
    invoke: (signal) => method.handler({ input, ctx: withSignal(ctx, signal), db: settings.db }),
    // A kit's handler is framework code: the development checks of statements are for the app's.
    quiet: settings.warnings.enabled && isKitHandler(method.handler),
    accept: (value) => accept(settings, target, value),
  });
  call.run = run;
  if (key !== undefined) {
    shares.add(key, run, method.ttlMs);
    call.source = run;
  }
  return run.join(call.signal);
}
