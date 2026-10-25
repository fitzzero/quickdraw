// What the admin kit's writes may hold (RFC 0003 section 12.4): checked
// before `adminCreate` and `adminUpdate` write, and the database's refusal
// of a write's values, after. A write never sets a field the service hides,
// one an override made read-only, `id` or a timestamp, nor a field above the
// caller's level; and, as for every kit write, it holds column values only
// (never a relation or a nested write, whoever the caller), and sets a
// column that decides access to the row only with a service-wide `Admin`
// grant (`../columns.ts`).
//
// The app's `prepare` runs before the write and may add column values to it
// (`prepareWrite`). Those are the server's own, so the checks of which fields
// the caller may name do not apply to them: a hidden field, one that is not
// editable, one above the caller's level and a column the policy reads (an
// owner or an access list, which comes only from `prepare` in the read/write
// kit too) may be set there. The checks that hold whoever writes do: never
// `id` or a timestamp, column values only, and each anchor column it sets (an
// `inherit` parent, an anchored collection's scope) names a row on which the
// caller has the method's row level, as for the read/write kit's `prepare`
// (5.1.1: no form, however lowered, moves a row into a parent the caller
// cannot reach at that level).

import { ADMIN_NEVER_WRITABLE, writtenData } from "../../../contract/kits/adminFields";
import { QuickdrawError } from "../../../protocol/errors";
import { checked } from "../../devWarnings";
import {
  checkAnchorColumns,
  checkWritableColumns,
  columnValueIssues,
  isPlainObject,
} from "../columns";
import { rowLevel } from "../crud/access";
import { checkSeen, type AdminCall } from "./runtime";
import type { AdminContext, AdminPrepare, AdminPrepareCall, AdminWrite } from "./types";

type Data = Readonly<Record<string, unknown>>;

/**
 * `VALIDATION` for a write that names a field the kit does not write (one the
 * service hides, `id`, a timestamp, or one an override made read-only), or
 * that holds a relation of the model or a nested write, and `FORBIDDEN` for
 * one above the caller's level, or for a column that decides access to the
 * row unless the caller holds a service-wide `Admin` grant (a lowered form
 * must not let a member make themselves the owner; an anchor column may move
 * the row only into an anchor row the caller has the row level on:
 * `../columns.ts`).
 */
export async function checkWrite(
  call: AdminCall,
  context: AdminContext,
  data: Readonly<Record<string, unknown>>,
): Promise<void> {
  const { hidden, readOnly } = call.fields;
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
  await checkWritableColumns(
    call.runtime,
    call.principal,
    data,
    rowLevel(context.form, "Moderate"),
    ["data"],
  );
}

/**
 * The issues of the column values `prepare` returned: `id` or a timestamp,
 * which the database sets, and a relation of the model or a nested write
 * (`columnValueIssues`), as for the caller's data.
 */
function preparedIssues(call: AdminCall, columns: Data): ReturnType<typeof columnValueIssues> {
  const never = Object.keys(columns)
    .filter((name) => ADMIN_NEVER_WRITABLE.includes(name))
    .map((name) => ({
      path: ["data", name],
      message: `"${name}" is not writable; the database sets it`,
    }));
  return [...never, ...columnValueIssues(call.runtime.service, columns, ["data"])];
}

/**
 * Runs the app's `prepare`, when it gave one, before a write, in the write's
 * transaction (`db`), and returns what the write sets: the caller's data
 * with the column values `prepare` returned over it, those it gave
 * `undefined` left out. Returning nothing keeps the caller's data, and an
 * `adminDelete` sets nothing, whatever it returns. `INTERNAL` for a return
 * that is not an object of column values; `VALIDATION` for one naming `id`
 * or a timestamp, or holding a relation or a nested write; `FORBIDDEN` for
 * an anchor column it sets to a row the caller lacks the method's row level
 * on (one engine call per anchor column it sets). `prepare` is the app's
 * code, so its statements are checked like a handler's.
 */
export async function prepareWrite(
  call: AdminCall,
  context: AdminContext,
  write: AdminPrepareCall,
  ctx: Parameters<AdminPrepare>[1],
  db: unknown,
): Promise<Data> {
  const { prepare } = context;
  const data = write.method === "adminDelete" ? {} : (write.data as Data);
  if (prepare === undefined) {
    return data;
  }
  const returned: unknown = await checked(() => prepare(write, ctx, db));
  if (write.method === "adminDelete" || returned === undefined) {
    return data;
  }
  const { name } = call.runtime.service;
  if (!isPlainObject(returned)) {
    throw new QuickdrawError(
      "INTERNAL",
      `The admin kit's prepare for ${name} must return column values, or nothing`,
    );
  }
  const columns = writtenData(returned);
  const issues = preparedIssues(call, columns);
  if (issues.length > 0) {
    throw new QuickdrawError(
      "VALIDATION",
      `The admin kit's prepare for ${name} returned data the kit does not write`,
      { issues },
    );
  }
  // Each parent it names, at the method's row level, as for the read/write kit's prepare.
  const level = rowLevel(context.form, "Moderate");
  await checkAnchorColumns(call.runtime, call.principal, columns, level, {
    creating: write.method === "adminCreate",
  });
  return { ...data, ...columns };
}

/**
 * Runs the app's `onWrite`, when it gave one, after a write, in the write's
 * transaction (`db`). It is the app's code, so its statements are checked
 * like a handler's, as `prepare`'s are: a loop of writes in it is an N+1.
 */
export async function runOnWrite(
  context: AdminContext,
  write: AdminWrite,
  ctx: Parameters<AdminPrepare>[1],
  db: unknown,
): Promise<void> {
  const { onWrite } = context;
  if (onWrite !== undefined) {
    await checked(() => onWrite(write, ctx, db));
  }
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
