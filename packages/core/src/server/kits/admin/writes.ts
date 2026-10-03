// What the admin kit's writes may hold (RFC 0003 section 12.4): checked
// before `adminCreate` and `adminUpdate` write, and the database's refusal
// of a write's values, after. A write never sets a field the service hides,
// one an override made read-only, `id` or a timestamp, nor a field above the
// caller's level; and, as for every kit write, a column that decides access
// to the row only with a service-wide `Admin` grant (`../columns.ts`).

import { QuickdrawError } from "../../../protocol/errors";
import { checkWritableColumns } from "../columns";
import { rowLevel } from "../crud/access";
import { checkSeen, type AdminCall } from "./runtime";
import type { AdminContext } from "./types";

/**
 * `VALIDATION` for a write that names a field the kit does not write (one the
 * service hides, `id`, a timestamp, or one an override made read-only), and
 * `FORBIDDEN` for one above the caller's level, or for a column that decides
 * access to the row unless the caller holds a service-wide `Admin` grant (a
 * lowered form must not let a member make themselves the owner; an anchor
 * column may move the row only into an anchor row the caller has the row
 * level on: `../columns.ts`).
 */
export async function checkWrite(
  call: AdminCall,
  context: AdminContext,
  data: Readonly<Record<string, unknown>>,
): Promise<void> {
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
  await checkWritableColumns(
    call.runtime,
    call.principal,
    data,
    rowLevel(context.form, "Moderate"),
  );
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
