// `initQuickdraw`: the one place an app states its types (RFC 0003 section 3).
//
//   export const qd = initQuickdraw<{ db: AppPrisma; principal: AppPrincipal }>();
//   export const taskService = qd.defineService(task, { methods: { ... } });
//
// Every service, handler argument and caller is typed from it. `context`
// adds the app's own fields to every handler's `ctx`, once for the whole app;
// it replaces 4.1's habit of overriding `defineMethod` per service.

import { QuickdrawError } from "../protocol/errors";
import { buildService } from "./buildService";
import { createCaller, type CallerFor } from "./caller";
import type { BaseContext, ContextExtender } from "./context";
import { createServer, type QuickdrawServer, type ServerOptions } from "./createServer";
import type { DefineService } from "./defineService";
import { createDispatcher, type Dispatcher, type DispatcherOptions } from "./dispatcher";
import type { Service } from "./service";
import type { ContextExtensionOf, PrincipalOf, QuickdrawTypes } from "./types";

/**
 * Builds the app's fields of `ctx` from the framework's. It runs once per
 * call, before access is checked, so `custom` checks see the fields too.
 */
export type ContextFactory<T extends QuickdrawTypes> = (
  base: BaseContext<PrincipalOf<T> | null>,
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

function noDispatcher(): never {
  throw new QuickdrawError(
    "INTERNAL",
    "qd.caller has no dispatcher to call through: create one with qd.createDispatcher (or qd.createServer) first",
  );
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
  const runtime = Object.freeze({ extendContext: contextOption(args[0]) });
  let current: Dispatcher | undefined;
  const qd: Quickdraw<T> = {
    defineService: ((contract: unknown, definition: unknown) =>
      buildService(runtime, contract, definition)) as DefineService<T>,
    createDispatcher(options) {
      const dispatcher = createDispatcher(options);
      current = dispatcher as Dispatcher;
      return dispatcher;
    },
    caller: (principal) =>
      createCaller(() => (current ?? noDispatcher()).call, principal) as CallerFor<T>,
    createServer(options) {
      const server = createServer(options);
      current = server.dispatcher as Dispatcher;
      return server;
    },
  };
  return Object.freeze(qd);
}
