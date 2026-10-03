// `defineService(contract, definition)` (RFC 0003 section 3): a declarative
// object, no classes. It replaces 4.1's `defineMethod(name, level, handler,
// { schema, resolveEntryId })` (`legacy-src/server/BaseService.ts:841-869`)
// and `verifyAllMethods`. The type of `methods` is the deliverable as much as
// the run-time check:
//
// - its keys must be exactly the contract's method names;
// - each handler receives `{ input, ctx, db }` with the parsed input
//   (`ParsedInputOf`), and must return the method's output (`OutputOf`): a
//   row of the projection for a projection output, wrapped by `nullable` and
//   `listOf`;
// - `access` is required, and its form decides `ctx.principal`: nullable
//   under `"public"` only;
// - `share`, `ttlMs` and `version` exist for queries only, `ttlMs` needs
//   `share`, and a method with `custom` access cannot `share: "all"`.
//
// Each method's access form is inferred into the type parameter `A`, one
// member per method. `access: A[M] | NoInfer<...>` keeps the `custom(fn)`
// callback typed while TypeScript infers `A`: a contextual type made only of
// `A[M]` would type its parameters as `unknown`.

import type { AnyContract } from "../contract/defineContract";
import type { KindOf, MethodName, OutputOf, ParsedInputOf } from "../contract/infer";
import type { Version } from "../protocol/envelope";
import type { AccessFor, CustomAccess, PublicAccess } from "./access/types";
import type { HandlerArgs, HandlerContext } from "./context";
import type { Service, ShareMode } from "./service";
import type { MaybePromise, PrincipalOf, QuickdrawTypes } from "./types";

/** The principal a method's handler sees: `null` is possible under `"public"` access only. */
export type PrincipalFor<T extends QuickdrawTypes, Access> = Access extends PublicAccess
  ? PrincipalOf<T> | null
  : PrincipalOf<T>;

/** The access forms method `M` may declare. `custom` checks receive an authenticated `ctx`. */
export type MethodAccess<
  T extends QuickdrawTypes,
  C extends AnyContract,
  M extends MethodName<C>,
> = AccessFor<ParsedInputOf<C, M>, HandlerContext<T>>;

/** One access form per contract method: the constraint of `defineService`'s inferred `A`. */
export type AccessMap<T extends QuickdrawTypes, C extends AnyContract> = {
  readonly [M in MethodName<C>]: MethodAccess<T, C, M>;
};

/**
 * A query's `share` and `ttlMs`: `ttlMs` only with `share`, since a result
 * that is not shared is never kept.
 */
type ShareOptions<A> =
  | {
      /**
       * Run identical concurrent calls once: `"caller"` per principal, `"all"`
       * across principals. Every caller is authorized before it joins; the
       * handler runs with the first caller's `ctx`, so a `"all"` handler must
       * not depend on who asks. `"all"` is not allowed with `custom` access,
       * whose result may depend on who asks.
       */
      readonly share: A extends CustomAccess<never, never> ? "caller" : ShareMode;
      /** Reuse a successful result for this long after its run, in milliseconds. */
      readonly ttlMs?: number;
    }
  | { readonly share?: undefined; readonly ttlMs?: undefined };

type QueryOptions<
  T extends QuickdrawTypes,
  C extends AnyContract,
  M extends MethodName<C>,
  A,
> = ShareOptions<A> & {
  /**
   * The current version of this query's result for `input`. A caller that
   * already holds it gets "not modified" instead of a fresh run.
   */
  readonly version?: (
    input: ParsedInputOf<C, M>,
    ctx: HandlerContext<T, PrincipalFor<T, A>>,
  ) => MaybePromise<Version>;
};

interface MutationOptions {
  readonly share?: never;
  readonly ttlMs?: never;
  readonly version?: never;
}

/** One method's implementation inside `defineService`'s `methods`. */
export type MethodImplementation<
  T extends QuickdrawTypes,
  C extends AnyContract,
  M extends MethodName<C>,
  A,
> = {
  /** Who may call: `"public"`, `"authenticated"`, `{ service }`, `{ entry }`, `{ scope, of, id }` or `custom(fn)`. */
  readonly access: A | NoInfer<MethodAccess<T, C, M>>;
  readonly handler: (
    args: HandlerArgs<T, ParsedInputOf<C, M>, PrincipalFor<T, A>>,
  ) => MaybePromise<OutputOf<C, M>>;
  /** This method's time limit in milliseconds, instead of the dispatcher's `callTimeoutMs`. */
  readonly timeoutMs?: number;
} & (KindOf<C, M> extends "query" ? QueryOptions<T, C, M, A> : MutationOptions);

type NotAMethod<
  C extends AnyContract,
  M,
> = `defineService: "${M & string}" is not a method of ${C["name"]}`;

/** The second argument of `qd.defineService`. */
export interface ServiceDefinition<T extends QuickdrawTypes, C extends AnyContract, A> {
  /** One implementation per contract method: no more, no fewer. */
  readonly methods: {
    readonly [M in keyof A]: M extends MethodName<C>
      ? MethodImplementation<T, C, M, A[M]>
      : NotAMethod<C, M>;
  };
  /**
   * Whether a service-wide `Admin` grant passes every access check of this
   * service (RFC 0003 section 4.1). Default `true`.
   */
  readonly adminBypass?: boolean;
}

/** `qd.defineService`, typed by the app's `QuickdrawTypes`. */
export type DefineService<T extends QuickdrawTypes> = <
  C extends AnyContract,
  const A extends AccessMap<T, C>,
>(
  contract: C,
  definition: ServiceDefinition<T, C, A>,
) => Service<T, C>;
