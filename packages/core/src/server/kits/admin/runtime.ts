// What every handler of the admin kit starts from (RFC 0003 section 12.4):
// the service its method runs in, found through the call's `ctx` as the other
// kits find it, the model's delegate on the dispatcher's tracked database
// client, and the fields the caller may see. Every write goes through that
// client, so the flush sends its frames; the kit sends none itself.
//
// An admin method reaches every row of its service: no policy filters it,
// since the default form needs a service-wide `Admin` grant, which reaches
// every row anyway. What a row shows follows the same grant: a field above
// the caller's service-wide level (a `fields` tier) is left out, as are the
// fields the service hides from the kit. With the default form the grant is
// `Admin`, which reaches every tier; a service that gives a method a lower
// form shows that method's callers less, and refuses them a filter, a sort
// or a write that names a field they cannot see (it would tell what the
// field holds).

import type { AdminSpec } from "../../../contract/kits/admin";
import { QuickdrawError } from "../../../protocol/errors";
import { serviceGrant } from "../../access/levels";
import { kitRuntimeOf, type KitRuntime } from "../../context";
import type { Projection } from "../../emit/projection";
import { modelKey } from "../../storage";
import type { Principal } from "../../types";
import { pageItem } from "../crud/list";
import type { KitHandlerArgs, ModelDelegate } from "../crud/runtime";
import type { AdminFields } from "./meta";

/** What one admin method's handler is made from. */
export interface AdminContext {
  /** What the contract half made the method for: its filter and sort fields. */
  readonly spec: AdminSpec;
  /** The service's fields as the kit configures them: what it hides, and what it does not write. */
  readonly fields: AdminFields;
}

/** One call of an admin method. */
export interface AdminCall {
  readonly runtime: KitRuntime;
  /** The service's model, named as the database client names it: `"task"`. */
  readonly model: string;
  readonly table: ModelDelegate;
  readonly principal: Principal | null;
  /** The entity projection: what a row is read with and sent as. */
  readonly projection: Projection;
  /** The fields above the caller's service-wide level: left out of rows, refused in filters, sorts and writes. */
  readonly unseen: ReadonlySet<string>;
  /** `unseen` and the fields the service hides from the kit: what no row of this call shows. */
  readonly omitted: ReadonlySet<string>;
}

/** The delegate of `model` on the dispatcher's database client. */
function tableOf(db: unknown, model: string): ModelDelegate {
  const name = modelKey(model);
  const isClient = (typeof db === "object" || typeof db === "function") && db !== null;
  const delegate: unknown = isClient ? Reflect.get(db, name) : undefined;
  const usable =
    typeof delegate === "object" &&
    delegate !== null &&
    typeof (delegate as { readonly findMany?: unknown }).findMany === "function";
  if (!usable) {
    throw new QuickdrawError(
      "INTERNAL",
      `The admin kit reads and writes through db.${name}, which the dispatcher's database client does not have`,
    );
  }
  return delegate as ModelDelegate;
}

/** The admin kit call `ctx` belongs to. */
export function adminCall(ctx: KitHandlerArgs["ctx"], db: unknown, fields: AdminFields): AdminCall {
  const runtime = kitRuntimeOf(ctx);
  const model = runtime?.service.model;
  const projection = runtime?.service.projections.get("entity");
  if (runtime === undefined || model === undefined || projection === undefined) {
    throw new QuickdrawError(
      "INTERNAL",
      "The admin kit's handlers run through a dispatcher, in a service with a model and an entity",
    );
  }
  const { principal } = ctx;
  const level = principal === null ? null : (serviceGrant(principal, runtime.service.name) ?? null);
  const unseen = projection.tiers.hidden(level);
  return {
    runtime,
    model: modelKey(model),
    table: tableOf(db, model),
    principal,
    projection,
    unseen,
    omitted: new Set([...unseen, ...fields.hidden]),
  };
}

/** A row as the call returns it: projected, without the fields it omits. */
export function rowOut(call: AdminCall, row: object): unknown {
  return pageItem(call.projection, row, call.omitted);
}

/** `FORBIDDEN` when the call names a field above the caller's level. */
export function checkSeen(call: AdminCall, names: readonly string[]): void {
  const unseen = names.find((name) => call.unseen.has(name));
  if (unseen !== undefined) {
    throw new QuickdrawError(
      "FORBIDDEN",
      `"${unseen}" is a field of ${call.runtime.service.name} above your access level`,
    );
  }
}

/**
 * `VALIDATION` for a write that names a field the kit does not write (one the
 * service hides, `id`, a timestamp, or one an override made read-only), and
 * `FORBIDDEN` for one above the caller's level.
 */
export function checkWrite(
  call: AdminCall,
  context: AdminContext,
  data: Readonly<Record<string, unknown>>,
): void {
  const { hidden, readOnly } = context.fields;
  const names = Object.keys(data);
  const issues = names
    .filter((name) => hidden.has(name) || readOnly.has(name))
    .map((name) => ({
      path: ["data", name],
      message: hidden.has(name) ? `"${name}" is not a writable field` : `"${name}" is not editable`,
    }));
  if (issues.length > 0) {
    throw new QuickdrawError("VALIDATION", "The data names fields the admin kit does not write", {
      issues,
    });
  }
  checkSeen(call, names);
}

/** True for Prisma's report of a value its column cannot hold: the wrong kind, or out of range. */
function isValueRefusal(error: unknown): error is Error {
  if (!(error instanceof Error)) {
    return false;
  }
  const { code } = error as Error & { readonly code?: unknown };
  return (
    error.name === "PrismaClientValidationError" ||
    (error.name === "PrismaClientKnownRequestError" && code === "P2020")
  );
}

/**
 * The database's refusal of a write's values (a value its column cannot
 * hold, a required column left out) as `VALIDATION`; anything else
 * unchanged. A foreign key that names no row stays `INTERNAL`, as for the
 * read/write kit.
 */
export function writeRefusal(error: unknown): unknown {
  if (!isValueRefusal(error)) {
    return error;
  }
  const message = "The database refused the row's data";
  const refused = new QuickdrawError("VALIDATION", message, {
    issues: [
      {
        path: ["data"],
        message: "A value does not fit its column, or a column the database requires was left out",
      },
    ],
  });
  refused.cause = error;
  return refused;
}
