// The types of `search.handlers` (RFC 0003 section 12.2). The contract half
// marks the method it made (`SearchTag`), so the server half finds it in any
// contract by type, under whatever name the contract gives it; what
// `search.handlers` returns spreads into `defineService`'s `methods`, which
// checks its form against what the service declares.

import type { AnyContract } from "../../../contract/defineContract";
import type { MethodName, ParsedInputOf } from "../../../contract/infer";
import type { AccessFor, PublicAccess } from "../../access/types";
import type { BaseContext } from "../../context";
import type { StorageWhere } from "../../storage";
import type { MaybePromise, Principal } from "../../types";
import type { KitHandler } from "../crud/runtime";
import type { KitContext } from "../crud/types";

/** The names of a contract's methods `search.contract` made. */
export type SearchMethodsOf<C extends AnyContract> = {
  [M in MethodName<C>]: "~search" extends keyof C["methods"][M] ? M : never;
}[MethodName<C>];

/** The access form of search kit methods `M` of `C`: what `search.handlers`' `access` takes. */
export type SearchAccess<
  C extends AnyContract,
  M extends SearchMethodsOf<C> = SearchMethodsOf<C>,
> = AccessFor<ParsedInputOf<C, M>, KitContext>;

/**
 * What a search strategy reads of the call's `ctx`: its caller (`null`
 * only in a `"public"` search called without credentials), its `signal`,
 * which aborts when the caller cancels, and its logger.
 */
export type SearchStrategyContext<A = unknown> = Pick<
  BaseContext<A extends PublicAccess ? Principal | null : Principal>,
  "principal" | "signal" | "log" | "requestId" | "transport"
>;

/** `strategy.ids`' options. */
export interface SearchIdsOptions {
  /** The most ids the page shows: the call's `limit`. */
  readonly limit: number;
}

/**
 * How a search finds its rows instead of the default, a case-insensitive
 * "contains" over the declared fields. Whatever it finds, the kit still
 * keeps to the rows the caller may read and, in a scope, to its members.
 * Which fields it matches is the strategy's own choice: unlike the default,
 * it is not kept from fields the caller's level does not receive (a field
 * tier), so leave those out or check `ctx.principal`, or a match tells what
 * they hold.
 */
export type SearchStrategy<Ctx = SearchStrategyContext> =
  | {
      /**
       * The filter of the rows that match `q`, in the database client's
       * `where` shape: a Postgres full-text condition, say. The kit adds the
       * access filter and the scope, and pages the rows by keyset cursor in
       * the scope collection's order (else by id).
       */
      readonly where: (q: string, ctx: Ctx) => MaybePromise<StorageWhere>;
      readonly ids?: never;
    }
  | {
      /**
       * Up to `limit` ids of rows that match `q`, best first, from an index
       * of the app's own. The kit reads those rows, keeps the ones the
       * caller may read (and, in a scope, its members) in this order, and
       * shows them as one page: `nextCursor` is always `null`.
       */
      readonly ids: (
        q: string,
        ctx: Ctx,
        options: SearchIdsOptions,
      ) => MaybePromise<readonly string[]>;
      readonly where?: never;
    };

/** The options of `search.handlers(contract, options)`. */
export interface SearchHandlersOptions<A, M extends string = string> {
  /**
   * Who may search, as for any method. The rows found are also kept to
   * those the service's policy gives the caller at the form's `entry` or
   * `scope` level (else `Read`), as for the read/write kit's `list`.
   */
  readonly access: A;
  /** How rows are found; a case-insensitive "contains" over the contract's `fields` without it. */
  readonly strategy?: NoInfer<SearchStrategy<SearchStrategyContext<A>>>;
  /**
   * The one search kit method to implement, for a contract with several
   * that need different access or strategies; every one without it.
   */
  readonly method?: M;
}

/** What `search.handlers` returns: one `{ access, handler, share }` per search kit method `M`, for `defineService`. */
export type SearchImplementations<M extends string, A> = {
  readonly [Name in M]: {
    readonly access: A;
    readonly handler: KitHandler;
    /** Identical concurrent searches by one caller run once. */
    readonly share: "caller";
  };
};

/** `search.handlers`' contract: one with a method the search kit made, or a message. */
export type SearchContract<C extends AnyContract> = [SearchMethodsOf<C>] extends [never]
  ? `search.handlers: ${C["name"]} has no method search.contract made`
  : C;
