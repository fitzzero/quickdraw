// The types of `admin.handlers` (RFC 0003 section 12.4). The contract half
// tags each method it made (`AdminTag`), so the server half finds the kit's
// methods in any contract by type: `access` may give a form for each of them
// and nothing else, `hiddenFields` and `fieldOverrides` name the entity's
// fields, and what `admin.handlers` returns spreads into `defineService`'s
// `methods`, one entry per admin method, with the form each runs under: a
// service-wide `Admin` grant unless `access` gives another.

import type { AnyContract } from "../../../contract/defineContract";
import type { EntityOf, ParsedInputOf } from "../../../contract/infer";
import type { AdminMethodsOf, AdminSpec } from "../../../contract/kits/admin";
import type { AdminFieldConfig } from "../../../contract/kits/adminFields";
import type { AccessFor, AccessForm } from "../../access/types";
import type { KitHandler } from "../crud/runtime";
import type { KitContext } from "../crud/types";
import type { AdminFields } from "./meta";

/** What one admin method's handler is made from. */
export interface AdminContext {
  /** What the contract half made the method for: its filter and sort fields. */
  readonly spec: AdminSpec;
  /** The service's fields as the kit configures them: what it hides, and what it does not write. */
  readonly fields: AdminFields;
  /** The method's access form: a write's row level comes from it. */
  readonly form: AccessForm;
}

/**
 * The form every admin method runs under when `access` gives none: the
 * caller's service-wide grant on the service must be `Admin`. A row-level
 * `Admin` (an owner, an access list entry, a member) does not pass it.
 */
export interface AdminDefaultAccess {
  readonly service: "Admin";
}

/** Access forms that replace the kit's default, per admin method of `C`. */
export type AdminAccess<C extends AnyContract> = {
  readonly [M in AdminMethodsOf<C>]?: AccessFor<ParsedInputOf<C, M>, KitContext>;
};

/** The entity's fields of `C`: what `hiddenFields` and `fieldOverrides` name. */
export type AdminFieldOf<C extends AnyContract> = keyof EntityOf<C> & string;

/**
 * What `fieldOverrides` may change of one field's configuration. `sortable`
 * and `filterable` follow the contract's declared fields; `editable` may be
 * turned off, and on for any field but `id` and the timestamps.
 */
export type AdminFieldOverride = Partial<
  Pick<
    AdminFieldConfig,
    "type" | "label" | "required" | "editable" | "showInTable" | "enumValues" | "relationService"
  >
>;

type NotAnAdminMethod<C extends AnyContract, A> = [Exclude<keyof A, AdminMethodsOf<C>>] extends [
  never,
]
  ? unknown
  : `admin.handlers: ${Exclude<keyof A, AdminMethodsOf<C>> & string} is not a method admin.contract made for ${C["name"]}`;

/** The options of `admin.handlers(contract, options)`. */
export interface AdminHandlersOptions<C extends AnyContract, A> {
  /**
   * Forms that replace the kit's default, `{ service: "Admin" }`, per method.
   * Whatever the form, an admin method reaches every row of the service: the
   * form only decides who may call it. Rows go out with the fields the
   * caller's service-wide grant reaches.
   */
  readonly access?: A & NoInfer<NotAnAdminMethod<C, A>>;
  /** The service's name on an admin screen; from its name without one (`taskService` is "Tasks"). */
  readonly displayName?: string;
  /**
   * Fields the kit leaves out entirely: from `adminMeta`, from the rows it
   * returns and from what it writes. `acl`, `serviceAccess` and
   * `service_access` are always hidden, as in 4.1, unless `grants` shows
   * the last two.
   */
  readonly hiddenFields?: readonly Exclude<AdminFieldOf<C>, "id">[];
  /**
   * Show and write the entity's `serviceAccess` (or `service_access`), the
   * user's service-wide grants, which the kit hides by default: an admin
   * screen then edits grants through `adminUpdate` (a JSON field, checked by
   * the entity's schema). Only a caller whose own service-wide grant on this
   * service is `Admin` reads or writes it, whatever `access` gives a method;
   * anyone else is refused a write, filter or sort naming it (`FORBIDDEN`)
   * and gets rows without it. Such an Admin can grant any service,
   * themself included, so give that grant only to those who may. With
   * `auth.serviceAccessSource` naming the column, a change reaches the
   * user's open sockets on every node at once (`qd:access`, their
   * subscriptions resolved again), as any tracked write to it does. Only for
   * an entity with such a field. Default `false`.
   */
  readonly grants?: [Extract<AdminFieldOf<C>, "serviceAccess" | "service_access">] extends [never]
    ? never
    : boolean;
  /** Changes to the configuration `adminMeta` derives, per field. */
  readonly fieldOverrides?: { readonly [Field in AdminFieldOf<C>]?: AdminFieldOverride };
  /**
   * The kit's methods whose access form is their whole check on purpose:
   * each gets `rowless: true`. On a service with an access policy,
   * `defineService` refuses `adminGet`, `adminUpdate` or `adminDelete`
   * under a form below the default that checks no row (`{ service:
   * "Moderate" }`, `"authenticated"`) unless it is named here, since any
   * caller the form admits reaches any row by its id.
   */
  readonly rowless?: readonly AdminMethodsOf<C>[];
}

type FormOf<A, M> = M extends keyof A
  ? [Exclude<A[M], undefined>] extends [never]
    ? AdminDefaultAccess
    : Exclude<A[M], undefined>
  : AdminDefaultAccess;

/**
 * What `admin.handlers` returns: one `{ access, handler }` per admin method
 * (with `rowless: true` for those `rowless` names), for `defineService`.
 */
export type AdminImplementations<C extends AnyContract, A> = {
  readonly [M in AdminMethodsOf<C>]: {
    readonly access: FormOf<A, M>;
    readonly handler: KitHandler;
    readonly rowless?: true;
  };
};

/** `admin.handlers`' contract: one with a method the admin kit made, or a message. */
export type AdminContract<C extends AnyContract> = [AdminMethodsOf<C>] extends [never]
  ? `admin.handlers: ${C["name"]} has no method admin.contract made`
  : C;
