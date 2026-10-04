// The in-process caller (RFC 0003 section 10): `caller.taskService.rename(input)`
// runs the same pipeline as a socket call, with transport `"internal"`. Its
// types come from the contracts: a method takes what a client would pass
// (`InputOf`) and resolves with what a client would receive (`OutputOf`).
// A failed call rejects with its `QuickdrawError`; an `INTERNAL` one keeps
// the original error as `cause`.
//
// A caller through a server's dispatcher (`qd.caller`, `server.dispatcher.caller`)
// gives a principal that carries no `serviceAccess` the grants the server's
// `auth.loadServiceAccess` loads, as a socket's handshake and an HTTP call
// do (finding F5.1 of the quickdraw-chat migration: an app's REST route ran
// its in-process call with no grants at all): once per caller, at its first
// call, and again after the server applied new grants to a user
// (`access.refresh`, a written grant, another node's broadcast), as a
// socket's are refreshed. A principal that carries grants, even `{}`, keeps
// exactly those.

import type { AnyContract } from "../contract/defineContract";
import type { ContractMap, InputOf, MethodName, OutputOf } from "../contract/infer";
import { INTERNAL_MESSAGE, QuickdrawError } from "../protocol/errors";
import type { Dispatch } from "./pipeline/pipeline";
import type { DispatchRequest } from "./pipeline/request";
import type { ServerAuth } from "./transports/auth";
import type { Principal, QuickdrawTypes } from "./types";

/** Options of one in-process call. */
export interface CallOptions {
  /** Cancels the call (queries only), like a client's `qd:cancel`. */
  readonly signal?: AbortSignal;
}

/** One method of the in-process caller. The input may be left out when the method accepts `undefined`. */
export type MethodCaller<C extends AnyContract, M extends MethodName<C>> = (
  ...args: undefined extends InputOf<C, M>
    ? [input?: InputOf<C, M>, options?: CallOptions]
    : [input: InputOf<C, M>, options?: CallOptions]
) => Promise<OutputOf<C, M>>;

/** The in-process caller of one service: one function per method. */
export type ServiceCaller<C extends AnyContract> = {
  readonly [M in MethodName<C>]: MethodCaller<C, M>;
};

/** The in-process caller of a set of contracts, by service name: `caller.taskService.rename(input)`. */
export type Caller<C extends AnyContract> = {
  readonly [Name in C["name"]]: ServiceCaller<Extract<C, { readonly name: Name }>>;
};

/**
 * The type of `qd.caller(principal)`: typed from the app's `contracts` when
 * `QuickdrawTypes` declares them, and untyped (any service, method and
 * input) otherwise.
 */
export type CallerFor<T extends QuickdrawTypes> = T extends {
  readonly contracts: infer Contracts extends ContractMap;
}
  ? Caller<Contracts[keyof Contracts]>
  : Caller<AnyContract>;

/** Where the in-process callers of a server's dispatcher get the grants of a principal that carries none. */
export interface CallerGrants {
  /** The server's `auth.loadServiceAccess`. */
  readonly load: NonNullable<ServerAuth["loadServiceAccess"]>;
  /**
   * Rises each time the server applies new grants to a user: a caller that
   * loaded its principal's grants before loads them again at its next call.
   */
  readonly version: () => number;
}

const CALLER_GRANTS = new WeakMap<object, CallerGrants>();

/**
 * Makes the in-process callers of `dispatcher` (its `caller`, and `qd.caller`
 * while it is the current one) load grants through `grants`: `createServer`
 * registers its `auth.loadServiceAccess`.
 */
export function setCallerGrants(dispatcher: object, grants: CallerGrants): void {
  CALLER_GRANTS.set(dispatcher, grants);
}

/** Where the callers of `dispatcher` load grants from, or `undefined` when they load none. */
export function callerGrantsOf(dispatcher: object | undefined): CallerGrants | undefined {
  return dispatcher === undefined ? undefined : CALLER_GRANTS.get(dispatcher);
}

/** How the calls of a {@link createCaller} run. */
export interface CallerSettings {
  /** Cancels every call too: `ctx.services` passes the calling method's `ctx.signal`. */
  readonly signal?: AbortSignal;
  /** Where to load a principal's grants from, asked at each call; `undefined` loads none. */
  readonly grants?: () => CallerGrants | undefined;
}

type MethodFunction = (input?: unknown, options?: CallOptions) => Promise<unknown>;

async function invoke(resolve: () => Dispatch, request: DispatchRequest): Promise<unknown> {
  const result = await resolve()(request);
  if (!result.ok) {
    throw result.error;
  }
  return result.notModified === true ? undefined : result.data;
}

/**
 * A read-only object whose members are made on first access and kept. It is
 * never mistaken for a promise: `then` reads as `undefined`.
 */
export function lazyMembers<Member>(make: (name: string) => Member): object {
  const made = new Map<string, Member>();
  return new Proxy(Object.freeze({}), {
    get(_target, name) {
      if (typeof name !== "string" || name === "then") {
        return undefined;
      }
      let member = made.get(name);
      if (member === undefined) {
        member = make(name);
        made.set(name, member);
      }
      return member;
    },
  });
}

/** `signal`, and also `outer` when there is one: aborted when either is. */
function bothSignals(outer: AbortSignal | undefined, signal: AbortSignal | undefined) {
  if (outer === undefined || signal === undefined) {
    return outer ?? signal;
  }
  return AbortSignal.any([outer, signal]);
}

/** True when `principal` carries grants of its own (`{}` included): they are kept as they are. */
function carriesGrants(principal: Principal): boolean {
  return principal.serviceAccess !== undefined && principal.serviceAccess !== null;
}

/** `principal` with the grants `grants` loads (`{}` for none). A failed load is `INTERNAL`, keeping the error as `cause`. */
async function withLoadedGrants(principal: Principal, grants: CallerGrants): Promise<Principal> {
  let serviceAccess: Awaited<ReturnType<CallerGrants["load"]>>;
  try {
    serviceAccess = await grants.load(principal.userId);
  } catch (error) {
    const failure = new QuickdrawError("INTERNAL", INTERNAL_MESSAGE);
    failure.cause = error;
    throw failure;
  }
  return { ...principal, serviceAccess: serviceAccess ?? {} };
}

/** What each call of a caller runs as: the principal, or a promise of it while its grants load. */
type PrincipalOfCall = () => Principal | null | Promise<Principal>;

/**
 * The principal each call of a caller runs as: `principal` itself when it is
 * `null`, carries grants, or `grants` gives no loader; else `principal` with
 * the grants loaded at the first call, kept until the server applied new
 * grants to a user (its version rose) or the loader changed. A load that
 * failed is not kept: the next call loads again.
 */
function principalOfCalls(
  principal: Principal | null,
  grants: CallerSettings["grants"],
): PrincipalOfCall {
  if (principal === null || carriesGrants(principal) || grants === undefined) {
    return () => principal;
  }
  interface Held {
    readonly from: CallerGrants;
    readonly version: number;
    readonly loading: Promise<Principal>;
    loaded?: Principal;
  }
  let held: Held | undefined;
  return () => {
    const from = grants();
    if (from === undefined) {
      return principal;
    }
    const version = from.version();
    if (held?.from === from && held.version === version) {
      return held.loaded ?? held.loading;
    }
    const entry: Held = { from, version, loading: withLoadedGrants(principal, from) };
    held = entry;
    entry.loading.then(
      (loaded) => {
        entry.loaded = loaded;
      },
      () => {
        if (held === entry) {
          held = undefined;
        }
      },
    );
    return entry.loading;
  };
}

/**
 * Creates an in-process caller acting as `principal` (`null` for an
 * anonymous caller). `resolve` returns the dispatch function to call through;
 * it is asked on every call, so a caller made before its dispatcher exists
 * works once one does. Every call is also cancelled with `settings.signal`,
 * when given (`ctx.services` passes the calling method's `ctx.signal`). With
 * `settings.grants`, a principal that carries no grants calls with the ones
 * it loads (see the top of this file).
 */
export function createCaller(
  resolve: () => Dispatch,
  principal: Principal | null,
  settings: CallerSettings = {},
): object {
  const principalOfCall = principalOfCalls(principal, settings.grants);
  return lazyMembers((service) =>
    lazyMembers<MethodFunction>((method) => async (input, options) => {
      const runAs = principalOfCall();
      return await invoke(resolve, {
        service,
        method,
        input,
        // Awaited only while grants load: a known principal is dispatched at once, as before.
        principal: runAs instanceof Promise ? await runAs : runAs,
        transport: "internal",
        signal: bothSignals(settings.signal, options?.signal),
      });
    }),
  );
}
