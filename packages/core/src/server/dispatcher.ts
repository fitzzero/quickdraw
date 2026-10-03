// The dispatcher: a registry of services plus the method pipeline, with one
// `call(request)` for every transport and a typed in-process caller.
// `qd.createServer` builds one; tests, jobs and the MCP bridge can build one
// directly.

import type { AnyContract } from "../contract/defineContract";
import type { DispatcherAccess } from "./access/api";
import { createCaller, type Caller } from "./caller";
import type { RunContext } from "./context";
import { registerLive, type Presence, type StreamHandle } from "./emit/live";
import { createPipeline, type DispatchRequest, type DispatchResult } from "./pipeline/pipeline";
import {
  resolveSettings,
  type DispatcherLimits,
  type PipelineOptions,
  type PipelineSettings,
} from "./pipeline/settings";
import { createRegistry, type Registry } from "./registry";
import type { AnyService } from "./service";
import type { DbOf, Principal, PrincipalOf } from "./types";

export type { Presence, StreamHandle };

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

/** `dispatcher.collections` and `qd.collections`: the services' collections (RFC 0003 section 7). */
export interface DispatcherCollections {
  /**
   * Sends one scope of a collection a `reset`, so its clients load it again:
   * for a change tracked writes cannot describe, such as a raw SQL write the
   * app did not `ctx.touch`. Throws a `TypeError` for a collection this
   * dispatcher does not serve.
   *
   * @example
   * qd.collections.reset(task, "byProject", projectId);
   */
  reset<C extends AnyContract>(
    contract: C,
    collection: keyof C["collections"] & string,
    scope: string,
  ): void;
}

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
   * `fn` gets a {@link RunContext}: `ctx.touch` records the rows a raw SQL
   * write changed.
   */
  run<T>(fn: (ctx: RunContext) => T | PromiseLike<T>): Promise<T>;
  /**
   * The services' access policies (RFC 0003 section 4): a principal's levels
   * on rows, list filters, and access-change events.
   */
  readonly access: DispatcherAccess;
  /** The services' collections: a manual `reset`. Deltas themselves come from tracked writes. */
  readonly collections: DispatcherCollections;
  /**
   * Who is online, when they were last seen, and who is in a room (RFC 0003
   * section 12.5), from the sockets of the server `createServer` attached;
   * without a server nobody is online.
   */
  readonly presence: Presence;
  /**
   * The handle of one of the services' streams (RFC 0003 section 12.5), whose
   * `push` appends an item: `dispatcher.stream(task, "logs").push(taskId,
   * line)`. Throws a `TypeError` for a stream the dispatcher does not serve.
   */
  stream<C extends AnyContract, K extends keyof C["streams"] & string>(
    contract: C,
    name: K,
  ): StreamHandle<C, K>;
  readonly registry: Registry;
  /** The resolved limits, for a server to announce in `qd:hello`. */
  readonly limits: DispatcherLimits;
}

const ACCESS_SINKS = new WeakMap<object, readonly PipelineSettings["flushSink"][]>();

/**
 * A copy of `options` whose dispatcher runs `sinks` right after its access
 * sink, before any frame of a flush is sent: `createServer`'s grants
 * refresh, so a flush that lowers a user's grants revokes what they held
 * before that flush's frames reach them.
 */
export function withAccessSinks<O extends object>(
  options: O,
  sinks: readonly PipelineSettings["flushSink"][],
): O {
  const copy = { ...options };
  ACCESS_SINKS.set(copy, sinks);
  return copy;
}

/** `dispatcher.run`: a unit of work around `fn`, flushed once `fn` settles. */
async function runInUnit<T>(
  settings: PipelineSettings,
  fn: (ctx: RunContext) => T | PromiseLike<T>,
): Promise<T> {
  if (typeof fn !== "function") {
    throw new TypeError("run: pass the function to run inside a unit of work");
  }
  const requestId = crypto.randomUUID();
  const unit = settings.unitOfWork.begin({
    requestId,
    transport: "internal",
    sink: settings.flushSink,
  });
  const ctx: RunContext = Object.freeze({
    touch: settings.touch,
    log: settings.logger.child({ requestId }),
    principal: null,
  });
  try {
    return await unit.run(() => fn(ctx));
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
  const settings = resolveSettings(options, registry, options.db, ACCESS_SINKS.get(options));
  // Writes made outside any unit of work flush to this dispatcher's sinks,
  // and the tracker's development warnings go out as this dispatcher's.
  settings.unitOfWork.attach?.(settings.flushSink, settings.logger, settings.warnings);
  const call = createPipeline(settings);
  const { levelsFor, accessWhere, onAccessChanged } = settings.policies;
  const dispatcher: Dispatcher<S> = Object.freeze({
    call,
    caller: (principal: PrincipalOfServices<S> | null) =>
      createCaller(() => call, principal) as Caller<ContractOfServices<S>>,
    run: <T>(fn: (ctx: RunContext) => T | PromiseLike<T>) => runInUnit(settings, fn),
    access: Object.freeze({ levelsFor, accessWhere, onAccessChanged }),
    collections: Object.freeze({
      reset: (contract: AnyContract, collection: string, scope: string) => {
        settings.live.resetCollection(contract, collection, scope);
      },
    }),
    presence: settings.live.realtime.presence,
    stream: <C extends AnyContract, K extends keyof C["streams"] & string>(contract: C, name: K) =>
      settings.live.realtime.stream(contract, name) as unknown as StreamHandle<C, K>,
    registry,
    limits: settings.limits,
  });
  // `createServer` attaches its Socket.IO server to the dispatcher's live data.
  registerLive(dispatcher, settings.live);
  return dispatcher;
}
