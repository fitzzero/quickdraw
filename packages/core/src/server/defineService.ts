// `defineService(contract, definition)` (RFC 0003 section 3): a declarative
// object, no classes. It replaces 4.1's `defineMethod(name, level, handler,
// { schema, resolveEntryId })` (`legacy-src/server/BaseService.ts:841-869`)
// and `verifyAllMethods`. The type of `methods` is the deliverable as much as
// the run-time check:
//
// - its keys must be exactly the contract's method names;
// - each handler receives `{ input, ctx, db }` with the parsed input
//   (`ParsedInputOf`), and returns the method's output: its schema's type,
//   or for a projection output the database row the framework projects
//   (`HandlerOutputOf`: `Date` values allowed, extra columns allowed, and
//   what the projection's `map` takes when it has one), wrapped by
//   `nullable` and `listOf`;
// - `access` is required, and its form decides `ctx.principal`: nullable
//   under `"public"` only;
// - `share`, `ttlMs` and `version` exist for queries only, `ttlMs` needs
//   `share`, and a method with `custom` access cannot `share: "all"`.
//
// Each method's access form is inferred into the type parameter `A`, one
// member per method. `access: A[M] | NoInfer<...>` keeps the `custom(fn)`
// callback typed while TypeScript infers `A`: a contextual type made only of
// `A[M]` would type its parameters as `unknown`.
//
// `model` and `access` (RFC 0003 sections 3 and 4.2) are inferred too, into
// `Model` and `Policy`. The policy's column names are checked against the
// model's columns in the app's database client, and they decide which
// row-level forms the methods may use: `entry` needs a policy, `scope` a
// model. `project` is inferred into `Proj`, so a projection's `map` types
// the handlers that return it.

import type { AnyContract } from "../contract/defineContract";
import type { KindOf, MethodName, ParsedInputOf } from "../contract/infer";
import type { Version } from "../protocol/envelope";
import type { ModelColumn, ModelName, PolicyFor } from "./access/policy";
import type { AccessFor, CustomAccess, PublicAccess, RowForms } from "./access/types";
import type { HandlerArgs, HandlerContext } from "./context";
import type { Service, ShareMode } from "./service";
import type { AffectsOption, HandlerOutputOf, ProjectCheck } from "./serviceTypes";
import type { DbOf, MaybePromise, PrincipalOf, QuickdrawTypes } from "./types";

type Empty = Record<never, never>;

/** The principal a method's handler sees: `null` is possible under `"public"` access only. */
export type PrincipalFor<T extends QuickdrawTypes, Access> = Access extends PublicAccess
  ? PrincipalOf<T> | null
  : PrincipalOf<T>;

/**
 * The access forms method `M` may declare, `Rows` limiting the row-level
 * ones to what its service declares. `custom` checks receive an
 * authenticated `ctx`.
 */
export type MethodAccess<
  T extends QuickdrawTypes,
  C extends AnyContract,
  M extends MethodName<C>,
  Rows extends RowForms = "all",
> = AccessFor<ParsedInputOf<C, M>, HandlerContext<T>, Rows>;

/** One access form per contract method: the constraint of `defineService`'s inferred `A`. */
export type AccessMap<
  T extends QuickdrawTypes,
  C extends AnyContract,
  Rows extends RowForms = "all",
> = {
  readonly [M in MethodName<C>]: MethodAccess<T, C, M, Rows>;
};

/** The row-level forms a service may use: `entry` needs an access policy, `scope` a model. */
export type RowFormsOf<Model, Policy> = [Model] extends [undefined]
  ? "none"
  : [Policy] extends [undefined]
    ? "scope"
    : "all";

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
  Rows extends RowForms = "all",
  Proj = Empty,
> = {
  /** Who may call: `"public"`, `"authenticated"`, `{ service }`, `{ entry }`, `{ scope, of, id }` or `custom(fn)`. */
  readonly access: A | NoInfer<MethodAccess<T, C, M, Rows>>;
  /**
   * Runs the method. For a projection output it returns the database row
   * (or rows, or `null`), which the framework projects: only the
   * projection's keys are sent, dates as ISO strings.
   */
  readonly handler: (
    args: HandlerArgs<T, ParsedInputOf<C, M>, PrincipalFor<T, A>>,
  ) => MaybePromise<HandlerOutputOf<C, M, Proj>>;
  /** This method's time limit in milliseconds, instead of the dispatcher's `callTimeoutMs`. */
  readonly timeoutMs?: number;
} & (KindOf<C, M> extends "query" ? QueryOptions<T, C, M, A> : MutationOptions);

type NotAMethod<
  C extends AnyContract,
  M,
> = `defineService: "${M & string}" is not a method of ${C["name"]}`;

/** The columns of the service's model, when it declares one. */
type ColumnOf<T extends QuickdrawTypes, Model> = Model extends string
  ? ModelColumn<DbOf<T>, Model>
  : never;

/** The second argument of `qd.defineService`. */
export interface ServiceDefinition<
  T extends QuickdrawTypes,
  C extends AnyContract,
  A,
  Model = undefined,
  Policy = undefined,
  Proj = Empty,
> {
  /**
   * The database model the service's rows live in, named as the client names
   * it (`"task"`). Needed for an access policy, for `scope` access and for
   * entity subscriptions; an RPC-only service leaves it out.
   */
  readonly model?: Model;
  /**
   * How a principal's level on one of the service's rows is found:
   * `owner(field)`, `jsonAcl(field)`, `members({...})`, `inherit({...})`,
   * `anyOf(...)` or `resolver({...})`. Needed for `entry` access and for
   * entity subscriptions. The column names it uses must be columns of `model`.
   */
  readonly access?: Policy;
  /** Other models the service's handlers write besides `model`, as the client names them (`"taskLabel"`). */
  readonly writes?: readonly ModelName<DbOf<T>>[];
  /**
   * Rows of other services a write to one of this service's rows changes
   * too, sent again after the flush (one hop): `[{ service: task, id:
   * "parentTaskId" }]`. Needs `model`.
   */
  readonly affects?: readonly AffectsOption<ColumnOf<T, Model>>[];
  /**
   * Options per projection (`"entity"` or a named one): `keys` for a schema
   * that cannot list them, and `select` plus `map` for relations and
   * computed fields.
   */
  readonly project?: Proj & NoInfer<ProjectCheck<C, Proj>>;
  /**
   * A column of `model` holding when the row last changed (`"updatedAt"`). A
   * caller that holds a row from no earlier than that time gets "not
   * modified" instead of the row. Without it, the in-process change log
   * answers.
   */
  readonly versionColumn?: ColumnOf<T, Model>;
  /** One implementation per contract method: no more, no fewer. */
  readonly methods: {
    readonly [M in keyof A]: M extends MethodName<C>
      ? MethodImplementation<T, C, M, A[M], RowFormsOf<Model, Policy>, NoInfer<Proj>>
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
  const Model extends ModelName<DbOf<T>> | undefined = undefined,
  Policy extends PolicyFor<DbOf<T>, Model> | undefined = undefined,
  const A extends AccessMap<T, C, RowFormsOf<Model, Policy>> = AccessMap<
    T,
    C,
    RowFormsOf<Model, Policy>
  >,
  const Proj = Empty,
>(
  contract: C,
  definition: ServiceDefinition<T, C, A, Model, Policy, Proj>,
) => Service<T, C>;
