// Guards for handlers, the kits' own and hand-written ones (RFC 0003 section
// 12). Four 4.1 apps copy a `services/shared/guards.ts` of these.

import { QuickdrawError } from "../../protocol/errors";

/**
 * The row a read found, or `NOT_FOUND` with `message` when it found none.
 *
 * @example
 * const task = requireRow(await db.task.findUnique({ where: { id } }), "No such task");
 */
export function requireRow<Row>(row: Row | null | undefined, message = "Not found"): Row {
  if (row === null || row === undefined) {
    throw new QuickdrawError("NOT_FOUND", message);
  }
  return row;
}
