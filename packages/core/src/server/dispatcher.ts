// The dispatcher: a registry of services plus the method pipeline, with one
// `call(request)` for every transport and a typed in-process caller.
// `qd.createServer` builds one; tests, jobs and the MCP bridge can build one
// directly.

import type { AnyContract } from "../contract/defineContract";
import { createCaller, type Caller } from "./caller";
import { createPipeline } from "./pipeline/pipeline";
import type { DispatchRequest, DispatchResult } from "./pipeline/request";
import { resolveSettings, type DispatcherLimits, type PipelineOptions } from "./pipeline/settings";
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
  readonly registry: Registry;
  /** The resolved limits, for a server to announce in `qd:hello`. */
  readonly limits: DispatcherLimits;
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
  const call = createPipeline(settings);
  return Object.freeze({
    call,
    caller: (principal: PrincipalOfServices<S> | null) =>
      createCaller(() => call, principal) as Caller<ContractOfServices<S>>,
    registry,
    limits: settings.limits,
  });
}
