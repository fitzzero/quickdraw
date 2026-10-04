// The types of `crud.handlers` (RFC 0003 section 12.1). The contract half
// marks each method it made with its kind (`CrudTag`), so the server half
// finds the kit's methods in any contract by type: `access` must give a form
// for each of them and for nothing else, and what `crud.handlers` returns
// spreads into `defineService`'s `methods`, which checks each form against
// what the service declares (an `entry` form needs its access policy).

import type { AnyContract } from "../../../contract/defineContract";
import type { MethodName, ParsedInputOf } from "../../../contract/infer";
import type { CrudMethodName, CrudSpec } from "../../../contract/kits/crud";
import type { AccessFor, AccessForm } from "../../access/types";
import type { BaseContext } from "../../context";
import type { Principal } from "../../types";
import type { AnyPrepare, CrudPrepare } from "./create";
import type { KitHandler } from "./runtime";

/** The names of a contract's methods the read/write kit made. */
export type CrudMethodsOf<C extends AnyContract> = {
  [M in MethodName<C>]: "~crud" extends keyof C["methods"][M] ? M : never;
}[MethodName<C>];

/** Which kit method contract method `M` is: `"get"`, `"list"`, ... */
export type CrudKindOf<C extends AnyContract, M extends MethodName<C>> = C["methods"][M] extends {
  readonly "~crud"?: infer Kind;
}
  ? Extract<Kind, CrudMethodName>
  : never;

/** What a `custom` access check of a kit method reads from `ctx`. */
export type KitContext = Pick<
  BaseContext<Principal>,
  "principal" | "signal" | "log" | "requestId" | "transport"
>;

/** One access form per kit method of `C`: what `crud.handlers`' `access` must give. */
export type CrudAccess<C extends AnyContract> = {
  readonly [M in CrudMethodsOf<C>]: AccessFor<ParsedInputOf<C, M>, KitContext>;
};

/** The kit's `create` method of `C`, or `never` without one. */
export type CrudCreateOf<C extends AnyContract> = {
  [M in CrudMethodsOf<C>]: CrudKindOf<C, M> extends "create" ? M : never;
}[CrudMethodsOf<C>];

type NotAKitMethod<C extends AnyContract, A> = [Exclude<keyof A, CrudMethodsOf<C>>] extends [never]
  ? unknown
  : `crud.handlers: ${Exclude<keyof A, CrudMethodsOf<C>> & string} is not a method crud.contract made for ${C["name"]}`;

/**
 * The options of `crud.handlers(contract, options)`. `Db` is the app's
 * database client type, taken from an annotated `db` of `prepare`
 * (`unknown` without one) and checked against the service's when the
 * handlers are spread into `qd.defineService`.
 */
export interface CrudHandlersOptions<C extends AnyContract, A, Db = unknown> {
  /**
   * Who may call each of the kit's methods: one form per method, required.
   * `get`, `update`, `delete` and `reorder` take `{ entry: L }` to check the
   * row; the methods on many rows also keep only the rows the service's
   * policy gives the caller at the form's level.
   */
  readonly access: A & NoInfer<NotAKitMethod<C, A>>;
  /**
   * What `create` writes, from its parsed input: set owner or scope columns
   * from `ctx.principal`, an ordinal from `nextOrdinal`. `create` writes the
   * input as it is without it.
   */
  readonly prepare?: [CrudCreateOf<C>] extends [never]
    ? `crud.handlers: prepare is for the kit's create, which ${C["name"]} does not have`
    : CrudPrepare<ParsedInputOf<C, CrudCreateOf<C>>, KitContext, Db>;
  /**
   * The kit's methods whose access form is their whole check on purpose:
   * each gets `rowless: true`. On a service with an access policy,
   * `defineService` refuses `get` under `"public"`, `"authenticated"` or
   * `{ service: L }` below `Admin` (any such caller could read any row by
   * its id) unless it is named here: `rowless: ["get"]` for public
   * profiles, say. `update`, `delete` and `reorder` check the row whatever
   * their form, and need nothing.
   */
  readonly rowless?: readonly CrudMethodsOf<C>[];
}

/**
 * What `crud.handlers` returns: one `{ access, handler }` per kit method
 * (with `rowless: true` for those `rowless` names), for `defineService`'s
 * `methods`.
 */
export type CrudImplementations<A, Db = unknown> = {
  readonly [M in keyof A]: {
    readonly access: A[M];
    readonly handler: KitHandler<Db>;
    readonly rowless?: true;
  };
};

/** What a kit method's handler is made from. */
export interface MethodContext {
  readonly spec: CrudSpec;
  readonly form: AccessForm;
  /** The projection a `list`'s items are. */
  readonly projection: string;
  readonly prepare: AnyPrepare | undefined;
}
