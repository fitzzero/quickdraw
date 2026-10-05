// `defineService(contract, definition)` (RFC 0003 section 3): a declarative
// object, no classes. It replaces 4.1's `defineMethod(name, level, handler,
// { schema, resolveEntryId })` (4.1 `src/server/BaseService.ts:841-869`)
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
// member per method, and checked by that method's `access` (`AccessValue`)
// rather than by `A`'s constraint, so a form TypeScript cannot infer (one
// holding an unannotated `id` function) leaves the other methods' forms, and
// their principals, as they are. The `NoInfer` forms beside `A[M]` keep the
// `custom(fn)` callback typed while TypeScript infers `A`: a contextual type
// made only of `A[M]` would type its parameters as `unknown`.
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
import type { AccessFor, CustomAccess, PublicAccess, RowForms, WatchAccess } from "./access/types";
import type { HandlerArgs, HandlerContext } from "./context";
import type {
  ChannelOptions,
  ChannelsRequired,
  RoomLeaveHandler,
  StreamOptions,
} from "./realtime/types";
import type { Service, ShareMode } from "./service";
import type {
  AffectsOption,
  CollectionOptions,
  CollectionsRequired,
  HandlerOutputOf,
  ProjectCheck,
} from "./serviceTypes";
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

/** One access form per contract method. */
export type AccessMap<
  T extends QuickdrawTypes,
  C extends AnyContract,
  Rows extends RowForms = "all",
> = {
  readonly [M in MethodName<C>]: MethodAccess<T, C, M, Rows>;
};

/**
 * The constraint of `defineService`'s inferred `A`: one entry per contract
 * method, of any type. TypeScript infers no form for a method whose `access`
 * holds an unannotated function (`id: (input) => input.projectId`), and
 * leaves it `unknown`; with `AccessMap` as the constraint, that one entry
 * would fail it, every method's form would fall back to the whole union,
 * and every handler's `ctx.principal` would be nullable. Each form is
 * checked by its method's `access` instead (`AccessValue`).
 */
type MethodKeys<C extends AnyContract> = { readonly [M in MethodName<C>]: unknown };

/**
 * `NoInfer` on each member of a union. TypeScript does not relate an object
 * literal to `X | NoInfer<A | B>` member by member: `{ service, entry }`
 * failed against it.
 */
type NoInferEach<U> = U extends unknown ? NoInfer<U> : never;

/**
 * What a method's `access` accepts, given `A`, the form inferred from it
 * (or, for an implementation written on its own, the form it is typed for:
 * `"authenticated"` for a handler that needs a principal): `A` itself when
 * it is one of `Forms`, then any of `Forms`, but not `"public"` unless `A`
 * may be `"public"`, since only then is the handler's principal nullable.
 * An `A` that is not one of `Forms`, or that TypeScript could not infer, is
 * replaced by `Forms`, so the value is still checked. The `NoInfer` keeps
 * the forms from absorbing the inference of `A` while still typing a
 * `custom(fn)` callback and an `id` function.
 */
type AccessValue<A, Forms> =
  | (unknown extends A ? Forms : A extends Forms ? A : Forms)
  | NoInferEach<PublicAccess extends A ? Forms : Exclude<Forms, PublicAccess>>;

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

/**
 * One method's implementation inside `defineService`'s `methods`. `A` is its
 * access form. For a method written in a module of its own, it says which
 * principal the handler gets: `satisfies MethodImplementation<Types, typeof
 * task, "rename", "authenticated">` takes any form but `"public"`, and the
 * principal is never null; with `"public"` it takes any form, and the
 * principal may be null.
 */
export type MethodImplementation<
  T extends QuickdrawTypes,
  C extends AnyContract,
  M extends MethodName<C>,
  A,
  Rows extends RowForms = "all",
  Proj = Empty,
> = {
  /** Who may call: `"public"`, `"authenticated"`, `{ service }`, `{ entry }`, `{ scope, of, id }` or `custom(fn)`. */
  readonly access: AccessValue<A, MethodAccess<T, C, M, Rows>>;
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
  /**
   * Says the access form is this method's whole check on purpose. On a
   * service with an access policy, `defineService` refuses a method whose
   * input has `id` while its access is `"public"`, `"authenticated"` or `{
   * service: L }` below `Admin`, since any caller the form admits could then
   * reach any row by its id: give it `{ entry: L }` so the policy decides,
   * or `rowless: true` when every such caller may reach any row (public
   * profiles, lookups by an id that tells nothing).
   */
  readonly rowless?: true;
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
  /**
   * How each collection of the contract authorizes its scopes (RFC 0003
   * section 7.1): `{ anchor: contract }`, the contract whose rows the scope
   * values are ids of, or `{ scopeAccess: "self" }` for a scope that is the
   * subscriber's user id; plus `bulkThreshold`. Required when the contract
   * declares collections. Needs `model`.
   */
  readonly collections?: CollectionOptions<C>;
  /**
   * Who may watch the service's change topic, `qd:watch { s, topic:
   * "service" }`, which changes on every flush that touches one of its rows
   * or collection scopes (RFC 0003 section 11.3): `"public"`,
   * `"authenticated"` or `{ service: level }`. Without it the topic is
   * closed (`FORBIDDEN`): it would tell any watcher when rows it may not
   * read change, other tenants' included. A collection scope's topic is
   * authorized as a subscribe to that scope instead.
   */
  readonly watchAccess?: WatchAccess;
  /** One implementation per contract method: no more, no fewer. */
  readonly methods: {
    readonly [M in keyof A]: M extends MethodName<C>
      ? MethodImplementation<T, C, M, A[M], RowFormsOf<Model, Policy>, NoInfer<Proj>>
      : NotAMethod<C, M>;
  };
  /**
   * One handler per contract channel (RFC 0003 section 12.5), no more and no
   * fewer: `(payload, ctx) => void`, or `{ access, handler }` where `access`
   * is `"authenticated"` (the default) or `{ service: level }`. A message
   * that is over its socket's rate, fails its schema, comes from an
   * anonymous socket, fails the access or the contract's `requires`, is
   * dropped without an answer. Required when the contract declares channels.
   */
  readonly channels?: ChannelOptions<T, C>;
  /**
   * Options per contract stream (RFC 0003 section 12.5), for any of them:
   * `seed`, a function `(scope, ctx) => items` computing each subscriber's
   * seed when it subscribes (the current state, where the contract's `seed:
   * n` keeps the latest items pushed); see `StreamImplementation`.
   *
   * @example
   * streams: { world: { seed: (worldId) => [game.world(worldId).snapshot()] } }
   */
  readonly streams?: StreamOptions<T, C>;
  /**
   * Called once for every socket that leaves app rooms (RFC 0003 section
   * 12.5), as `createServer`'s option of the same name is: a method's
   * `ctx.rooms.leave(room)` (`reason: "leave"`), `rooms.leave(room, { userId
   * })` (`"removed"`), or a disconnect, which leaves every app room the
   * socket was in (`"disconnect"`), each room with `last`: no socket of the
   * user is in it any more, on any node. Declared on the service that joins
   * its sockets to the rooms (a game's world), so every server the service
   * runs in calls it: `createServer`, and so `createTestApp`, run each
   * service's hook and the server's own, each in a unit of work of its own,
   * once per leave; one that throws is logged and the others still run. It
   * hears every app room a socket leaves: check the room's name.
   *
   * @example
   * onRoomLeave: ({ principal, rooms }) => {
   *   if (principal !== null && rooms.some(({ room, last }) => room === WORLD && last)) {
   *     removePlayer(principal.userId);
   *   }
   * },
   */
  readonly onRoomLeave?: RoomLeaveHandler<PrincipalOf<T>>;
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
  const A extends MethodKeys<C> = AccessMap<T, C, RowFormsOf<Model, Policy>>,
  const Proj = Empty,
>(
  contract: C,
  definition: ServiceDefinition<T, C, A, Model, Policy, Proj> &
    CollectionsRequired<C> &
    ChannelsRequired<C>,
) => Service<T, C>;
