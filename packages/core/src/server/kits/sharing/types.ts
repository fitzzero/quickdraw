// The types of `sharing.handlers` (RFC 0003 section 12.3). The contract half
// tags each method it made with its kind (`SharingTag`), so the server half
// finds the kit's methods in any contract by type: `access` may give a form
// for each of them and nothing else, `resolveUser` is required exactly when
// the contract has a by-name method, and what `sharing.handlers` returns
// spreads into `defineService`'s `methods`, one entry per kit method, with
// the form each runs under (the kit's default unless `access` gives one).

import type { AnyContract } from "../../../contract/defineContract";
import type { MethodName, ParsedInputOf } from "../../../contract/infer";
import type { SharingByNameMethod, SharingMethodName } from "../../../contract/kits/sharing";
import type { AccessFor } from "../../access/types";
import type { MaybePromise } from "../../types";
import type { KitHandler } from "../crud/runtime";
import type { KitContext } from "../crud/types";

/** The names of a contract's methods the sharing kit made. */
export type SharingMethodsOf<C extends AnyContract> = {
  [M in MethodName<C>]: "~sharing" extends keyof C["methods"][M] ? M : never;
}[MethodName<C>];

/** Which sharing kit method contract method `M` is: `"share"`, `"invite"`, ... */
export type SharingKindOf<
  C extends AnyContract,
  M extends MethodName<C>,
> = C["methods"][M] extends {
  readonly "~sharing"?: infer Kind;
}
  ? Extract<Kind, SharingMethodName>
  : never;

/** The names of a contract's by-name sharing methods (`shareByName`, `inviteByName`). */
export type SharingByNameOf<C extends AnyContract> = {
  [M in SharingMethodsOf<C>]: SharingKindOf<C, M> extends SharingByNameMethod ? M : never;
}[SharingMethodsOf<C>];

/**
 * The form a sharing kit method runs under when `access` gives none: a
 * change needs `Admin` on the row, a list `Read`, and `leave` only a
 * signed-in caller, who must be a member.
 */
export type SharingDefaultAccess<Kind extends SharingMethodName> = Kind extends "leave"
  ? "authenticated"
  : Kind extends "listShares"
    ? { readonly entry: "Read" }
    : Kind extends "listMembers"
      ? { readonly entry: "Read"; readonly id: "entryId" }
      : Kind extends "share" | "shareByName" | "unshare" | "setLevel"
        ? { readonly entry: "Admin" }
        : { readonly entry: "Admin"; readonly id: "entryId" };

/** Access forms that replace the kit's defaults, per sharing kit method of `C`. */
export type SharingAccess<C extends AnyContract> = {
  readonly [M in SharingMethodsOf<C>]?: AccessFor<ParsedInputOf<C, M>, KitContext>;
};

/** What the sharing kit changed: one user's access to one row. */
export type SharingChangeKind =
  | "share"
  | "unshare"
  | "setLevel"
  | "invite"
  | "remove"
  | "leave"
  | "setRole";

/** One change the sharing kit made, as `onChange` receives it. */
export interface SharingChange {
  /** What was done; a by-name method reports `"share"` or `"invite"`. */
  readonly kind: SharingChangeKind;
  /** The row: the call's `id` (`"acl"`) or `entryId` (`"members"`). */
  readonly id: string;
  /** The user whose access changed. */
  readonly userId: string;
  /** Their level in the access list, or their stored role, before the change; `null` for none. */
  readonly before: string | null;
  /** The same after the change; `null` when they have none now. */
  readonly after: string | null;
}

/**
 * Runs after each change, inside the change's transaction, with that
 * transaction's tracked client as `db` (the app's client type `Db`, when
 * the callback's `db` is annotated with it): its writes commit with the
 * change, and a throw undoes the change and fails the call.
 */
export type SharingOnChange<Db = unknown> = (
  change: SharingChange,
  ctx: KitContext,
  db: Db,
) => MaybePromise<void>;

/** Who a by-name method means: the `name` and `email` the call gave. */
export interface SharingUserLookup {
  readonly name?: string;
  readonly email?: string;
}

/**
 * Finds the user a by-name method means: their user id, or `null` (or
 * `undefined`) when there is no such user, which fails the call with
 * `NOT_FOUND`.
 */
export type SharingResolveUser<Db = unknown> = (
  lookup: SharingUserLookup,
  ctx: KitContext,
  db: Db,
) => MaybePromise<string | null | undefined>;

type NotASharingMethod<C extends AnyContract, A> = [Exclude<keyof A, SharingMethodsOf<C>>] extends [
  never,
]
  ? unknown
  : `sharing.handlers: ${Exclude<keyof A, SharingMethodsOf<C>> & string} is not a method sharing.contract made for ${C["name"]}`;

/**
 * The options of `sharing.handlers(contract, options)`. `Db` is the app's
 * database client type, taken from an annotated `db` of `onChange` or
 * `resolveUser` (`unknown` without one) and checked against the service's.
 */
export type SharingHandlersOptions<C extends AnyContract, A, Db = unknown> = {
  /**
   * Forms that replace the kit's defaults, per method: changes need
   * `{ entry: "Admin" }` on the row, lists `{ entry: "Read" }`, and `leave`
   * `"authenticated"`.
   */
  readonly access?: A & NoInfer<NotASharingMethod<C, A>>;
  /** Runs after each change, inside its transaction: an audit row, a notification. */
  readonly onChange?: SharingOnChange<Db>;
} & ([SharingByNameOf<C>] extends [never]
  ? {
      readonly resolveUser?: `sharing.handlers: resolveUser is for shareByName and inviteByName, which ${C["name"]} does not have`;
    }
  : {
      /** Finds the user `shareByName` and `inviteByName` mean, by name or email. */
      readonly resolveUser: SharingResolveUser<Db>;
    });

/** `sharing.handlers`' options argument: required when the contract has a by-name method. */
export type SharingOptionsArgs<C extends AnyContract, A, Db = unknown> = [
  SharingByNameOf<C>,
] extends [never]
  ? [options?: SharingHandlersOptions<C, A, Db>]
  : [options: SharingHandlersOptions<C, A, Db>];

type FormOf<C extends AnyContract, A, M extends SharingMethodsOf<C>> = M extends keyof A
  ? [Exclude<A[M], undefined>] extends [never]
    ? SharingDefaultAccess<SharingKindOf<C, M>>
    : Exclude<A[M], undefined>
  : SharingDefaultAccess<SharingKindOf<C, M>>;

/** What `sharing.handlers` returns: one `{ access, handler }` per sharing kit method, for `defineService`. */
export type SharingImplementations<C extends AnyContract, A, Db = unknown> = {
  readonly [M in SharingMethodsOf<C>]: {
    readonly access: FormOf<C, A, M>;
    readonly handler: KitHandler<Db>;
  };
};

/** `sharing.handlers`' contract: one with a method the sharing kit made, or a message. */
export type SharingContract<C extends AnyContract> = [SharingMethodsOf<C>] extends [never]
  ? `sharing.handlers: ${C["name"]} has no method sharing.contract made`
  : C;
