// The in-process caller (RFC 0003 section 10): `caller.taskService.rename(input)`
// runs the same pipeline as a socket call, with transport `"internal"`. Its
// types come from the contracts: a method takes what a client would pass
// (`InputOf`) and resolves with what a client would receive (`OutputOf`).
// A failed call rejects with its `QuickdrawError`; an `INTERNAL` one keeps
// the original error as `cause`.

import type { AnyContract } from "../contract/defineContract";
import type { ContractMap, InputOf, MethodName, OutputOf } from "../contract/infer";
import type { Dispatch } from "./pipeline/pipeline";
import type { DispatchRequest } from "./pipeline/request";
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

/**
 * Creates an in-process caller acting as `principal` (`null` for an
 * anonymous caller). `resolve` returns the dispatch function to call through;
 * it is asked on every call, so a caller made before its dispatcher exists
 * works once one does.
 */
export function createCaller(resolve: () => Dispatch, principal: Principal | null): object {
  return lazyMembers((service) =>
    lazyMembers<MethodFunction>(
      (method) => (input, options) =>
        invoke(resolve, {
          service,
          method,
          input,
          principal,
          transport: "internal",
          signal: options?.signal,
        }),
    ),
  );
}
