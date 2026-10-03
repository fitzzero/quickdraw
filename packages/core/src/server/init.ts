// `initQuickdraw`: the one place an app states its types (RFC 0003 section 3).
//
//   export const qd = initQuickdraw<{ db: AppPrisma; principal: AppPrincipal }>();
//   export const taskService = qd.defineService(task, { methods: { ... } });
//
// Every service, handler argument and caller is typed from it. `context`
// adds the app's own fields to every handler's `ctx`, once for the whole app;
// it replaces 4.1's habit of overriding `defineMethod` per service.

import type { AnyContract } from "../contract/defineContract";
import { QuickdrawError } from "../protocol/errors";
import { buildService } from "./buildService";
import { createCaller, type CallerFor } from "./caller";
import type { BaseContext, ContextExtender } from "./context";
import { createServer, type QuickdrawServer, type ServerOptions } from "./createServer";
import type { DefineService } from "./defineService";
import {
  createDispatcher,
  type Dispatcher,
  type DispatcherCollections,
  type DispatcherOptions,
  type Presence,
  type StreamHandle,
} from "./dispatcher";
import type { Service } from "./service";
import type { ContextExtensionOf, McpContextOf, PrincipalOf, QuickdrawTypes } from "./types";

/**
 * Builds the app's fields of `ctx` from the framework's. It runs once per
 * call, before access is checked, so `custom` checks see the fields too.
 */
export type ContextFactory<T extends QuickdrawTypes> = (
  base: BaseContext<PrincipalOf<T> | null, McpContextOf<T>>,
) => ContextExtensionOf<T>;

/** Options of `initQuickdraw`. */
export interface InitOptions<T extends QuickdrawTypes> {
  /** Adds the app's fields to every handler's `ctx`. Required when the app's types declare `context`. */
  readonly context?: ContextFactory<T>;
}

/** `initQuickdraw`'s arguments: the options are required when `T` declares `context`. */
export type InitArgs<T extends QuickdrawTypes> = T extends { readonly context: object }
  ? [options: InitOptions<T> & { readonly context: ContextFactory<T> }]
  : [options?: InitOptions<T>];

/** What `initQuickdraw` returns. */
export interface Quickdraw<T extends QuickdrawTypes> {
  /**
   * Defines a service from its contract: one `{ access, handler }` per
   * contract method, no more and no fewer.
   */
  readonly defineService: DefineService<T>;
  /**
   * Creates a dispatcher for `services` and makes it the one `qd.caller`
   * calls through. The last dispatcher created wins.
   */
  createDispatcher<const S extends readonly Service<T>[]>(
    options: DispatcherOptions<S>,
  ): Dispatcher<S>;
  /**
   * An in-process caller acting as `principal` (`null` for anonymous),
   * through the dispatcher this instance created last:
   * `qd.caller(user).taskService.rename(input)`. Typed by the `contracts` of
   * the app's types; `dispatcher.caller` is typed by its own services.
   */
  caller(principal: PrincipalOf<T> | null): CallerFor<T>;
  /**
   * Runs `fn` inside a unit of work of the dispatcher this instance created
   * last, so the tracked writes of a job, script or webhook flush to its
   * sinks once `fn` settles, as a method's do (RFC 0003 section 5.1). Writes
   * made outside any unit of work still flush, on the next tick, with a
   * development warning. Inside a method or a transaction, `fn` joins it.
   *
   * @example
   * await qd.run(() => db.task.updateMany({ where: { dueAt: { lt: now } }, data: { status: "late" } }));
   */
  run<R>(fn: () => R | PromiseLike<R>): Promise<R>;
  /**
   * The collections of the dispatcher this instance created last (RFC 0003
   * section 7): `qd.collections.reset(contract, collection, scope)` sends one
   * scope a `reset`, for a change tracked writes cannot describe.
   */
  readonly collections: DispatcherCollections;
  /**
   * The handle of a stream (RFC 0003 section 12.5), for handlers, jobs and
   * timers: `qd.stream(task, "logs").push(taskId, line)` (`push(item)` for a
   * global stream). Each push goes through the dispatcher this instance
   * created last, so a handle can be made when a module loads; pushing
   * before any dispatcher exists, or to a stream it does not serve, throws.
   * Throws a `TypeError` at once for a stream the contract does not declare.
   */
  stream<C extends AnyContract, K extends keyof C["streams"] & string>(
    contract: C,
    name: K,
  ): StreamHandle<C, K>;
  /**
   * Who is online and who is in a room (RFC 0003 section 12.5), through the
   * dispatcher this instance created last: the same as `ctx.presence`.
   */
  readonly presence: Presence;
  /**
   * Serves `services` over Socket.IO and HTTP on the app's Express app and
   * HTTP server (see `createServer`), and makes the server's dispatcher the
   * one `qd.caller` calls through.
   */
  createServer<const S extends readonly Service<T>[]>(
    options: ServerOptions<S>,
  ): QuickdrawServer<S>;
}

function contextOption(options: unknown): ContextExtender | undefined {
  if (options === undefined) {
    return undefined;
  }
  if (typeof options !== "object" || options === null) {
    throw new TypeError("initQuickdraw: options must be an object");
  }
  const { context } = options as { readonly context?: unknown };
  if (context !== undefined && typeof context !== "function") {
    throw new TypeError("initQuickdraw: context must be a function of the base context");
  }
  return context as ContextExtender | undefined;
}

const NEEDS: Readonly<Record<string, string>> = Object.freeze({
  "qd.run": "flush through",
  "qd.collections.reset": "send through",
  "qd.stream": "push through",
  "qd.presence": "ask",
});

function noDispatcher(member: string): never {
  throw new QuickdrawError(
    "INTERNAL",
    `${member} has no dispatcher to ${NEEDS[member] ?? "call through"}: create one with qd.createDispatcher (or qd.createServer) first`,
  );
}

type Current = () => Dispatcher | undefined;

/** `qd.stream`: a handle that pushes through the current dispatcher, resolving the stream once per dispatcher. */
function streamOf(
  current: Current,
  contract: AnyContract,
  name: string,
): StreamHandle<AnyContract, string> {
  const streams: unknown =
    typeof contract === "object" && contract !== null ? contract.streams : undefined;
  if (typeof streams !== "object" || streams === null || !Object.hasOwn(streams, name)) {
    throw new TypeError(
      `qd.stream: ${String(contract?.name)} declares no stream "${String(name)}"`,
    );
  }
  let resolved:
    | { readonly from: Dispatcher; readonly handle: StreamHandle<AnyContract, string> }
    | undefined;
  return Object.freeze({
    push(...args: unknown[]): void {
      const from = current() ?? noDispatcher("qd.stream");
      if (resolved?.from !== from) {
        resolved = { from, handle: from.stream(contract, name) };
      }
      (resolved.handle.push as (...items: unknown[]) => void)(...args);
    },
  }) as StreamHandle<AnyContract, string>;
}

/** `qd.presence`: presence through the current dispatcher. */
function presenceOf(current: Current): Presence {
  const presence = (): Presence => (current() ?? noDispatcher("qd.presence")).presence;
  return Object.freeze({
    isOnline: async (userId: string) => await presence().isOnline(userId),
    lastSeen: async (userId: string) => await presence().lastSeen(userId),
    count: async (room: string) => await presence().count(room),
    users: async (room: string) => await presence().users(room),
  });
}

/**
 * Starts a quickdraw app. The type argument states the app's types once:
 * the database client handlers receive, the principal type, the fields
 * `context` adds to `ctx`, and the contracts that type `qd.caller`.
 *
 * @example
 * export const qd = initQuickdraw<{ db: AppPrisma; principal: AppPrincipal }>();
 */
export function initQuickdraw<T extends QuickdrawTypes = QuickdrawTypes>(
  ...args: InitArgs<T>
): Quickdraw<T> {
  let current: Dispatcher | undefined;
  const runtime = Object.freeze({
    extendContext: contextOption(args[0]),
    adopt: (dispatcher: object) => {
      current = dispatcher as Dispatcher;
    },
  });
  const qd: Quickdraw<T> = {
    defineService: ((contract: unknown, definition: unknown) =>
      buildService(runtime, contract, definition)) as DefineService<T>,
    createDispatcher(options) {
      const dispatcher = createDispatcher(options);
      current = dispatcher as Dispatcher;
      return dispatcher;
    },
    caller: (principal) =>
      createCaller(() => (current ?? noDispatcher("qd.caller")).call, principal) as CallerFor<T>,
    run: async (fn) => await (current ?? noDispatcher("qd.run")).run(fn),
    collections: Object.freeze({
      reset: (contract, collection, scope) => {
        (current ?? noDispatcher("qd.collections.reset")).collections.reset(
          contract,
          collection,
          scope,
        );
      },
    } satisfies DispatcherCollections),
    stream: <C extends AnyContract, K extends keyof C["streams"] & string>(contract: C, name: K) =>
      streamOf(() => current, contract, name) as unknown as StreamHandle<C, K>,
    presence: presenceOf(() => current),
    createServer(options) {
      const server = createServer(options);
      current = server.dispatcher as Dispatcher;
      return server;
    },
  };
  return Object.freeze(qd);
}
