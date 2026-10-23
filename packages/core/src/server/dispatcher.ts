// The dispatcher: a registry of services plus the method pipeline, with one
// `call(request)` for every transport and a typed in-process caller.
// `qd.createServer` builds one; tests, jobs and the MCP bridge can build one
// directly.

import type { AnyContract } from "../contract/defineContract";
import type { DispatcherAccess } from "./access/api";
import { callerGrantsOf, createCaller, type Caller } from "./caller";
import type { RunContext, RunOptions } from "./context";
import { registerLive, type Presence, type ServerRooms, type StreamHandle } from "./emit/live";
import { createPipeline, type DispatchRequest, type DispatchResult } from "./pipeline/pipeline";
import {
  errorText,
  resolveSettings,
  type DispatcherLimits,
  type PipelineOptions,
  type PipelineSettings,
} from "./pipeline/settings";
import { createRegistry, type Registry } from "./registry";
import { servedProblem, type AnyService, type ServedContext, type Service } from "./service";
import type { DbOf, McpContext, McpContextOf, Principal, PrincipalOf } from "./types";

export type { Presence, ServerRooms, Service, StreamHandle };

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

/** The type of `ctx.mcp` for the services of `S`: their app's `QuickdrawTypes["mcp"]`. */
export type McpContextOfServices<S extends readonly AnyService[]> = [S[number]] extends [never]
  ? McpContext
  : McpContextOf<TypesOf<S>>;

/**
 * The options `createDispatcher` and `createServer` share: the services and
 * the database client handlers receive, plus the pipeline's seams and
 * limits. `db` may be left out only when the services declared no database
 * type.
 */
export type DispatcherBaseOptions<S extends readonly AnyService[]> = PipelineOptions & {
  /** The services to serve. Two services with one name are an error. */
  readonly services: S;
} & (unknown extends DbOfServices<S>
    ? { readonly db?: DbOfServices<S> }
    : { readonly db: DbOfServices<S> });

/** Options of {@link createDispatcher}: the shared ones, and where users' grants are stored. */
export type DispatcherOptions<S extends readonly AnyService[]> = DispatcherBaseOptions<S> & {
  /**
   * Where users' service-wide grants are stored, as `{ model: "user",
   * column: "serviceAccess" }`: the admin kit on that model treats the
   * column as the grants field, whatever its name (hidden unless
   * `grants: true`, and then for service-wide Admins only). `createServer`
   * takes it as `auth.serviceAccessSource`, which also refreshes the grants
   * it stores; a dispatcher made without `createServer` (an app that serves
   * HTTP with `createHttpRouter`, an MCP process) names it here, or the
   * column is an ordinary field there.
   */
  readonly serviceAccessSource?: { readonly model: string; readonly column: string };
};

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
   * not capped. Through a server's dispatcher, a principal that carries no
   * `serviceAccess` gets the grants `auth.loadServiceAccess` loads, once per
   * caller and again after the server applied new grants, as a socket's
   * handshake does; one that carries grants keeps exactly those.
   */
  caller(principal: PrincipalOfServices<S> | null): Caller<ContractOfServices<S>>;
  /**
   * Runs `fn` inside a unit of work, as a method's handler runs (RFC 0003
   * section 5.1): the tracked writes it makes flush to the dispatcher's
   * sinks once it settles, whether it resolved or threw, and before `run`
   * returns. Inside an open unit of work or transaction, `fn` joins it
   * instead, unless `detached` (see {@link RunOptions}) gives it a unit of
   * its own. For jobs, scripts and webhooks that write outside a method, and
   * a handler's background work. `fn` gets a {@link RunContext}: `ctx.touch`
   * records the rows a raw SQL write changed.
   */
  run<T>(fn: (ctx: RunContext) => T | PromiseLike<T>, options?: RunOptions): Promise<T>;
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
   * App rooms from code that is not a handler (RFC 0003 section 12.5): typed
   * room events (`emit`, `emitToUser`) and `leave(room, { userId })`, on
   * every node of the attached server; without a server nothing is sent.
   */
  readonly rooms: ServerRooms;
  /**
   * The handle of one of the services' streams (RFC 0003 section 12.5), whose
   * `push` appends an item: `dispatcher.stream(task, "logs").push(taskId,
   * line)`, and whose `subscribers(taskId)` counts the sockets that watch the
   * feed on every node. Throws a `TypeError` for a stream the dispatcher does
   * not serve, a host-served one included.
   */
  stream<C extends AnyContract, K extends keyof C["streams"] & string>(
    contract: C,
    name: K,
  ): StreamHandle<C, K>;
  readonly registry: Registry;
  /** The resolved limits, for a server to announce in `qd:hello`. */
  readonly limits: DispatcherLimits;
  /**
   * Where users' service-wide grants are stored, as the dispatcher was made
   * with it (`serviceAccessSource`, which `createServer` takes from
   * `auth.serviceAccessSource`): the admin kit on that model treats the
   * column as the grants field. `undefined` without one.
   */
  readonly serviceAccessSource: { readonly model: string; readonly column: string } | undefined;
}

/** What `createServer` gives the dispatcher it makes, beside the app's options. */
export interface ServerParts {
  /**
   * Sinks to run right after the access sink, before any frame of a flush
   * is sent: `createServer`'s grants refresh, so a flush that lowers a
   * user's grants revokes what they held before that flush's frames reach
   * them.
   */
  readonly accessSinks: readonly PipelineSettings["flushSink"][];
}

const SERVER_PARTS = new WeakMap<object, ServerParts>();

/** A copy of `options` whose dispatcher gets `parts` (one marker: each copy would lose another's). */
export function withServerParts<O extends object>(options: O, parts: ServerParts): O {
  const copy = { ...options };
  SERVER_PARTS.set(copy, parts);
  return copy;
}

/** The `serviceAccessSource` option, checked: `{ model, column }`, or `undefined`. */
function grantsSourceOf(source: unknown): ServedContext["grantsSource"] {
  if (source === undefined) {
    return undefined;
  }
  const { model, column } = (source ?? {}) as {
    readonly model?: unknown;
    readonly column?: unknown;
  };
  if (typeof model !== "string" || model === "" || typeof column !== "string" || column === "") {
    throw new TypeError(
      'createDispatcher: serviceAccessSource must be { model, column }, as { model: "user", column: "serviceAccess" }',
    );
  }
  return Object.freeze({ model, column });
}

/** `TypeError` for the first handler a service cannot be served with (`checkWhenServed`). */
function checkServed(
  services: readonly AnyService[],
  grantsSource: ServedContext["grantsSource"],
): void {
  for (const service of services) {
    for (const method of Object.values(service.methods)) {
      const problem = servedProblem(method.handler, { service, grantsSource });
      if (problem !== undefined) {
        throw new TypeError(`createDispatcher: ${service.name}: ${problem}`);
      }
    }
  }
}

/** `run`'s `detached` option, checked. */
function detachedOf(options: RunOptions | undefined): boolean {
  if (options === undefined) {
    return false;
  }
  if (typeof options !== "object" || options === null) {
    throw new TypeError("run: options must be an object, { detached?: boolean }");
  }
  const { detached } = options;
  if (detached !== undefined && typeof detached !== "boolean") {
    throw new TypeError("run: detached must be true or false");
  }
  return detached === true;
}

/** `dispatcher.run`: a unit of work around `fn`, flushed once `fn` settles. */
export async function runInUnit<T>(
  settings: PipelineSettings,
  fn: (ctx: RunContext) => T | PromiseLike<T>,
  options?: RunOptions,
): Promise<T> {
  if (typeof fn !== "function") {
    throw new TypeError("run: pass the function to run inside a unit of work");
  }
  const detached = detachedOf(options);
  const requestId = crypto.randomUUID();
  const unit = settings.unitOfWork.begin({
    requestId,
    transport: "internal",
    sink: settings.flushSink,
    ...(detached ? { detached } : {}),
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
        error: errorText(error),
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
  const grantsSource = grantsSourceOf(options.serviceAccessSource);
  checkServed(options.services, grantsSource);
  const settings = resolveSettings(options, registry, options.db, {
    accessSinks: SERVER_PARTS.get(options)?.accessSinks ?? [],
    grantsSource,
  });
  // Writes made outside any unit of work flush to this dispatcher's sinks,
  // and the tracker's development warnings go out as this dispatcher's,
  // until a server's `close()` detaches it.
  const detach = settings.unitOfWork.attach?.(
    settings.flushSink,
    settings.logger,
    settings.warnings,
  );
  const call = createPipeline(settings);
  const { levelsFor, accessWhere, onAccessChanged } = settings.policies;
  const dispatcher: Dispatcher<S> = Object.freeze({
    call,
    caller: (principal: PrincipalOfServices<S> | null) =>
      createCaller(() => call, principal, {
        grants: () => callerGrantsOf(dispatcher),
      }) as Caller<ContractOfServices<S>>,
    run: <T>(fn: (ctx: RunContext) => T | PromiseLike<T>, runOptions?: RunOptions) =>
      runInUnit(settings, fn, runOptions),
    access: Object.freeze({ levelsFor, accessWhere, onAccessChanged }),
    collections: Object.freeze({
      reset: (contract: AnyContract, collection: string, scope: string) => {
        settings.live.resetCollection(contract, collection, scope);
      },
    }),
    presence: settings.live.realtime.presence,
    rooms: settings.live.realtime.rooms,
    stream: <C extends AnyContract, K extends keyof C["streams"] & string>(contract: C, name: K) =>
      settings.live.realtime.stream(contract, name) as unknown as StreamHandle<C, K>,
    registry,
    limits: settings.limits,
    serviceAccessSource: grantsSource,
  });
  // `createServer` attaches its Socket.IO server to the dispatcher's live data.
  registerLive(dispatcher, settings.live);
  LOOPS.set(dispatcher, settings.loops);
  DETACHES.set(dispatcher, () => {
    // The access cache stops hearing the client's writes, which other dispatchers go on making;
    // the tracker detaches even when that throws.
    try {
      settings.policies.close();
    } finally {
      if (typeof detach === "function") {
        detach();
      }
    }
  });
  // Last, so a construction that throws leaves no listener behind; it is synchronous, so no
  // write lands before this. From here the access cache hears the client's writes.
  settings.policies.listen();
  return dispatcher;
}

const DETACHES = new WeakMap<object, () => void>();

const LOOPS = new WeakMap<object, PipelineSettings["loops"]>();

/**
 * The loop watch of a dispatcher `createDispatcher` returned: `createServer`
 * counts its socket rate limiter's refusals there too (`devWarnings.ts`).
 */
export function loopsOf(dispatcher: object): PipelineSettings["loops"] | undefined {
  return LOOPS.get(dispatcher);
}

/**
 * Detaches `dispatcher` from its tracked database client: ambient writes
 * and the warnings outside calls go back to the dispatcher attached before
 * it (or nowhere), and its access cache (`cacheMs`) stops hearing the
 * client's writes (`PolicyEngine.close`). A server's `close()` calls it once
 * the server stopped.
 */
export function detachDispatcher(dispatcher: object): void {
  DETACHES.get(dispatcher)?.();
}
