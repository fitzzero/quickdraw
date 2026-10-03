// The dispatcher: a registry of services plus the method pipeline, with one
// `call(request)` for every transport and a typed in-process caller.
// `qd.createServer` builds one; tests, jobs and the MCP bridge can build one
// directly.

import type { AnyContract } from "../contract/defineContract";
import type { DispatcherAccess } from "./access/api";
import { createCaller, type Caller } from "./caller";
import { createPipeline } from "./pipeline/pipeline";
import type { DispatchRequest, DispatchResult } from "./pipeline/request";
import {
  resolveSettings,
  type DispatcherLimits,
  type PipelineOptions,
  type PipelineSettings,
} from "./pipeline/settings";
import { createRegistry, type Registry } from "./registry";
import type { AnyService } from "./service";
import type { DbOf, Principal, PrincipalOf } from "./types";

type TypesOf<S extends readonly AnyService[]> = NonNullable<S[number]["~types"]>;

/** The database client the services of `S` were declared with. */
export type DbOfServices<S extends readonly AnyService[]> = [S[number]] extends [never]
  ? unknown
  : DbOf<TypesOf<S>>;

/** The principal type the services of `S` were declared with. */
export type PrincipalOfServices<S extends readonly AnyService[]> = [S[number]] extends [never]
  ? Principal
  : PrincipalOf<TypesOf<S>>;

/** The contracts the services of `S` were defined from. */
export type ContractOfServices<S extends readonly AnyService[]> = [S[number]] extends [never]
  ? AnyContract
  : S[number]["contract"];

/**
 * Options of {@link createDispatcher}: the services and the database client
 * handlers receive, plus the pipeline's seams and limits. `db` may be left
 * out only when the services declared no database type.
 */
export type DispatcherOptions<S extends readonly AnyService[]> = PipelineOptions & {
  /** The services to serve. Two services with one name are an error. */
  readonly services: S;
} & (unknown extends DbOfServices<S>
    ? { readonly db?: DbOfServices<S> }
    : { readonly db: DbOfServices<S> });

/** A registry of services and the method pipeline that serves them. */
export interface Dispatcher<S extends readonly AnyService[] = readonly AnyService[]> {
  /**
   * Runs one call through the pipeline. Resolves once the result was handed
   * to `request.respond`, the run flushed and the completion record emitted.
   * Never rejects: a failure is a result with `ok: false`.
   */
  call(request: DispatchRequest): Promise<DispatchResult>;
  /**
   * A typed in-process caller acting as `principal`, `null` for anonymous:
   * `dispatcher.caller(user).taskService.rename(input)`. Calls go through the
   * whole pipeline with transport `"internal"` and no connection, so they are
   * not capped.
   */
  caller(principal: PrincipalOfServices<S> | null): Caller<ContractOfServices<S>>;
  /**
   * Runs `fn` inside a unit of work, as a method's handler runs (RFC 0003
   * section 5.1): the tracked writes it makes flush to the dispatcher's
   * sinks once it settles, whether it resolved or threw, and before `run`
   * returns. Inside an open unit of work or transaction, `fn` joins it
   * instead. For jobs, scripts and webhooks that write outside a method.
   */
  run<T>(fn: () => T | PromiseLike<T>): Promise<T>;
  /**
   * The services' access policies (RFC 0003 section 4): a principal's levels
   * on rows, list filters, and access-change events.
   */
  readonly access: DispatcherAccess;
  readonly registry: Registry;
  /** The resolved limits, for a server to announce in `qd:hello`. */
  readonly limits: DispatcherLimits;
}

/** `dispatcher.run`: a unit of work around `fn`, flushed once `fn` settles. */
async function runInUnit<T>(settings: PipelineSettings, fn: () => T | PromiseLike<T>): Promise<T> {
  if (typeof fn !== "function") {
    throw new TypeError("run: pass the function to run inside a unit of work");
  }
  const unit = settings.unitOfWork.begin({
    requestId: crypto.randomUUID(),
    transport: "internal",
    sink: settings.flushSink,
  });
  try {
    return await unit.run(fn);
  } finally {
    try {
      await unit.flush();
    } catch (error) {
      settings.logger.error("Flushing a run's writes failed", {
        category: "quickdraw.flush",
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }
}

/**
 * Creates a dispatcher for `services`.
 *
 * @example
 * const dispatcher = createDispatcher({ services: [taskService], db: prisma });
 * await dispatcher.caller(user).taskService.rename({ id, title });
 */
export function createDispatcher<const S extends readonly AnyService[]>(
  options: DispatcherOptions<S>,
): Dispatcher<S> {
  if (typeof options !== "object" || options === null) {
    throw new TypeError("createDispatcher: options must be an object with services and db");
  }
  const registry = createRegistry(options.services);
  const settings = resolveSettings(options, registry, options.db);
  // Writes made outside any unit of work flush to this dispatcher's sinks.
  settings.unitOfWork.attach?.(settings.flushSink, settings.logger);
  const call = createPipeline(settings);
  const { levelsFor, accessWhere, onAccessChanged } = settings.policies;
  return Object.freeze({
    call,
    caller: (principal: PrincipalOfServices<S> | null) =>
      createCaller(() => call, principal) as Caller<ContractOfServices<S>>,
    run: <T>(fn: () => T | PromiseLike<T>) => runInUnit(settings, fn),
    access: Object.freeze({ levelsFor, accessWhere, onAccessChanged }),
    registry,
    limits: settings.limits,
  });
}
