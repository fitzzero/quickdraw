// The read/write kit's `reorder` (RFC 0003 section 12.1): moves a row
// between two others of the same ordered list (the rows sharing its
// `within` columns), ascending by the declared column. `beforeId` is the row
// that will come right before it and `afterId` the row right after; given
// one, the kit finds the other. The moved row takes the whole number halfway
// between its neighbors (`ordinal.ts`), so a move is one write; when no gap
// is left, the list is renumbered first.
//
// A move reads its neighbors and writes from what it read, so it runs
// SERIALIZABLE, as a sharing change does (`../transactions.ts`): two moves
// into one gap at once would otherwise both take its midpoint. A conflict
// the database reports is `CONFLICT`; the caller may try again.
//
// The moved row and the neighbors a move names need the method's row level
// (one batched lookup): a neighbor below it is `NOT_FOUND`, as a missing
// one or one of another list is. The list a move reads, counts and
// renumbers is the rows sharing the moved row's `within` values that the
// caller may write at that level, so a list with no `within` or a null one
// is the caller's own and reaches no other tenant's row (the 5.1 audit's
// CRUD-6: a caller named other tenants' rows as neighbors, read their
// ordinals, and made renumbering write them).
//
// Statements: the lookup and the write filter's reads (none when the
// caller's grant reaches every row), then, in one transaction: one read of
// the row and its neighbors, one more to find the missing neighbor when only
// one is given, and the write. When no gap is left, that transaction ends
// without writing; the list's rows are counted, and a second transaction, given
// `RENUMBER_BASE_MS` plus `RENUMBER_MS_PER_ROW` for each row (a client's
// default limit, Prisma's 5 s, would fail a long list every time), reads the
// rows again, renumbers (one read, and one write per row whose ordinal
// changes) and moves. The renumbering's frames reach a collection scope as a
// `reset` once they pass the scope's `bulkThreshold`.

import type { CrudSpec } from "../../../contract/kits/crud";
import type { ReorderInput } from "../../../contract/kits/crudSchemas";
import { QuickdrawError } from "../../../protocol/errors";
import type { AccessFilter } from "../../access/policy";
import type { StorageWhere } from "../../storage";
import type { AccessForm } from "../../access/types";
import { inKitTransaction } from "../transactions";
import { allowedIds, rowLevel, rowsWhere } from "./access";
import { isOrdinal, ordinalBetween, ORDINAL_STEP } from "./ordinal";
import {
  crudCall,
  delegateOf,
  projectionOf,
  type CrudCall,
  type KitHandler,
  type KitHandlerArgs,
  type ModelDelegate,
  type Row,
  uniqueIds,
} from "./runtime";

type ReorderSpec = Extract<CrudSpec, { method: "reorder" }>;

/** The rows a move names, read once. */
interface Named {
  readonly moved: Row;
  readonly before: Row | undefined;
  readonly after: Row | undefined;
}

function invalid(message: string, path: readonly string[]): QuickdrawError {
  return new QuickdrawError("VALIDATION", message, { issues: [{ path: [...path], message }] });
}

/**
 * Reads the moved row and its named neighbors. A neighbor that is missing or
 * in another list is `NOT_FOUND` alike, so a move cannot tell whether a row
 * of another list exists.
 */
async function readNamed(
  table: ModelDelegate,
  spec: ReorderSpec,
  move: ReorderInput,
  model: string,
): Promise<Named> {
  const select = Object.fromEntries(["id", spec.column, ...spec.within].map((key) => [key, true]));
  const ids = [move.id, move.beforeId, move.afterId].filter((id) => id !== undefined);
  const rows = await table.findMany({ where: { id: { in: ids } }, select });
  const byId = new Map(rows.map((row) => [row.id, row]));
  const moved = byId.get(move.id);
  if (moved === undefined) {
    throw new QuickdrawError("NOT_FOUND", `No such ${model}`);
  }
  const neighbor = (id: string | undefined, key: string): Row | undefined => {
    const row = id === undefined ? undefined : byId.get(id);
    const listed =
      row !== undefined && spec.within.every((column) => row[column] === moved[column]);
    if (id !== undefined && !listed) {
      throw new QuickdrawError("NOT_FOUND", `No such ${model} in this list as ${key}`);
    }
    return row;
  };
  return {
    moved,
    before: neighbor(move.beforeId, "beforeId"),
    after: neighbor(move.afterId, "afterId"),
  };
}

/**
 * The rows of the moved row's list, the moved row left out: those sharing
 * its `within` values that the caller may write (`writable`; `undefined`:
 * every row, `"none"`: none).
 */
function listOf(spec: ReorderSpec, moved: Row, writable: AccessFilter | undefined): StorageWhere {
  const scope = Object.fromEntries(spec.within.map((column) => [column, moved[column] ?? null]));
  const mine = writable === undefined ? [] : [writable === "none" ? { id: { in: [] } } : writable];
  return { AND: [scope, { id: { not: moved.id } }, ...mine] };
}

/** The row right after (`"next"`) or right before (`"previous"`) `row` in the list. */
async function adjacent(
  table: ModelDelegate,
  spec: ReorderSpec,
  list: StorageWhere,
  row: Row,
  side: "next" | "previous",
): Promise<Row | null> {
  const { column } = spec;
  const beyond = side === "next" ? "gt" : "lt";
  const direction = side === "next" ? "asc" : "desc";
  const value = row[column];
  return await table.findFirst({
    where: {
      AND: [
        list,
        { OR: [{ [column]: { [beyond]: value } }, { [column]: value, id: { [beyond]: row.id } }] },
      ],
    },
    orderBy: [{ [column]: direction }, { id: direction }],
    select: { id: true, [column]: true },
  });
}

/**
 * The ordinals the moved row goes between, `null` for an end of the list,
 * or `undefined` when a neighbor's ordinal is not a usable number.
 */
async function bounds(
  table: ModelDelegate,
  spec: ReorderSpec,
  named: Named,
  writable: AccessFilter | undefined,
): Promise<[low: number | null, high: number | null] | undefined> {
  const { column } = spec;
  const { before, after } = named;
  const list = listOf(spec, named.moved, writable);
  const low =
    before ?? (after === undefined ? null : await adjacent(table, spec, list, after, "previous"));
  const high =
    after ?? (before === undefined ? null : await adjacent(table, spec, list, before, "next"));
  const lowValue = low === null ? null : low[column];
  const highValue = high === null ? null : high[column];
  const usable = (value: unknown): boolean => value === null || isOrdinal(value);
  if (!usable(lowValue) || !usable(highValue)) {
    return undefined;
  }
  if (before !== undefined && after !== undefined && (lowValue as number) > (highValue as number)) {
    throw invalid("beforeId comes after afterId in the list", ["afterId"]);
  }
  return [lowValue as number | null, highValue as number | null];
}

/** Renumbers the list in steps with the moved row in its new place; returns the moved row's ordinal. */
async function renumber(
  table: ModelDelegate,
  [spec, writable]: readonly [ReorderSpec, AccessFilter | undefined],
  named: Named,
  move: ReorderInput,
): Promise<number> {
  const { column } = spec;
  const rows = await table.findMany({
    where: listOf(spec, named.moved, writable),
    select: { id: true, [column]: true },
    orderBy: [{ [column]: "asc" }, { id: "asc" }],
  });
  const order = rows.map((row) => row.id);
  const at =
    move.beforeId === undefined
      ? Math.max(order.indexOf(move.afterId), 0)
      : order.indexOf(move.beforeId) + 1;
  order.splice(at, 0, move.id);
  const current = new Map(rows.map((row) => [row.id, row[column]]));
  let placed = ORDINAL_STEP;
  for (const [index, id] of order.entries()) {
    const value = (index + 1) * ORDINAL_STEP;
    if (id === move.id) {
      placed = value;
    } else if (current.get(id) !== value) {
      await table.update({ where: { id }, data: { [column]: value }, select: { id: true } });
    }
  }
  return placed;
}

/** A renumbering transaction's time limit: this much, plus `RENUMBER_MS_PER_ROW` for each row of the list. */
export const RENUMBER_BASE_MS = 5_000;

/** The time a renumbering transaction is given for each row of the list it renumbers. */
export const RENUMBER_MS_PER_ROW = 10;

const OWNER = "The read/write kit's reorder";

const CONFLICT = "Another change to this list ran at the same time; try again";

/** One move: the call, what it asks, the rows the caller may write, and what the moved row is read back with. */
interface Move {
  readonly call: CrudCall;
  readonly spec: ReorderSpec;
  readonly move: ReorderInput;
  readonly writable: AccessFilter | undefined;
  readonly select: Readonly<Record<string, unknown>>;
}

/**
 * Moves the row inside `tx`: to the whole number between its new neighbors,
 * or, with `mayRenumber`, after renumbering its list. Without it, a move
 * with no gap left writes nothing and answers the list to renumber.
 */
async function moveIn(
  tx: unknown,
  { call, spec, move, writable, select }: Move,
  mayRenumber: boolean,
): Promise<{ readonly row: Row } | { readonly list: StorageWhere }> {
  const table = delegateOf(tx, call.model);
  const named = await readNamed(table, spec, move, call.model);
  const range = await bounds(table, spec, named, writable);
  const between =
    range === undefined ? undefined : ordinalBetween(range[0] ?? undefined, range[1] ?? undefined);
  if (between === undefined && !mayRenumber) {
    return { list: listOf(spec, named.moved, writable) };
  }
  const value = between ?? (await renumber(table, [spec, writable], named, move));
  return {
    row: await table.update({ where: { id: move.id }, data: { [spec.column]: value }, select }),
  };
}

/**
 * `FORBIDDEN` unless the caller may write the moved row at `level`, and
 * `NOT_FOUND` for a named neighbor it may not, as for a missing one: one
 * batched lookup.
 */
async function checkNamed(
  call: CrudCall,
  [form, level]: readonly [AccessForm, ReturnType<typeof rowLevel>],
  move: ReorderInput,
): Promise<void> {
  const named = [move.beforeId, move.afterId].filter((id) => id !== undefined);
  const ids = uniqueIds([move.id, ...named]);
  const writable = new Set(await allowedIds(call, form, ids, level, "write"));
  if (!writable.has(move.id)) {
    throw new QuickdrawError("FORBIDDEN", "Insufficient permissions");
  }
  for (const [id, key] of [
    [move.beforeId, "beforeId"],
    [move.afterId, "afterId"],
  ] as const) {
    if (id !== undefined && !writable.has(id)) {
      throw new QuickdrawError("NOT_FOUND", `No such ${call.model} in this list as ${key}`);
    }
  }
}

/**
 * The `reorder` handler: the caller needs the method's row level on the
 * moved row and on the neighbors it names, whatever the form, and the list
 * is the rows it may write.
 */
export function reorderHandler(spec: ReorderSpec, form: AccessForm): KitHandler {
  const level = rowLevel(form, "Moderate");
  const handler = async ({ input, ctx, db }: KitHandlerArgs): Promise<Row> => {
    const call = crudCall(ctx, db);
    const asked = input as ReorderInput;
    await checkNamed(call, [form, level], asked);
    const move: Move = {
      call,
      spec,
      move: asked,
      writable: await rowsWhere(call, form, level, "write"),
      select: projectionOf(call, "entity").select,
    };
    const how = { owner: OWNER, conflict: CONFLICT };
    const first = await inKitTransaction(db, async (tx) => await moveIn(tx, move, false), how);
    if ("row" in first) {
      return first.row;
    }
    // No gap left: renumber, in a transaction given time for every row of the list.
    const rows = await call.table.count({ where: first.list });
    const timeoutMs = RENUMBER_BASE_MS + (rows + 1) * RENUMBER_MS_PER_ROW;
    const moved = await inKitTransaction(db, async (tx) => await moveIn(tx, move, true), {
      ...how,
      timeoutMs,
    });
    if (!("row" in moved)) {
      throw new QuickdrawError("INTERNAL", "A renumbering reorder wrote no row");
    }
    return moved.row;
  };
  return handler as KitHandler;
}
