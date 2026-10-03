// The read/write kit's `reorder` (RFC 0003 section 12.1): moves a row
// between two others of the same ordered list (the rows sharing its
// `within` columns), ascending by the declared column. `beforeId` is the row
// that will come right before it and `afterId` the row right after; given
// one, the kit finds the other. The moved row takes the whole number halfway
// between its neighbors (`ordinal.ts`), so a move is one write; when no gap
// is left, the list is renumbered in the same transaction.
//
// Statements, inside one transaction: one read of the row and its
// neighbors, one more to find the missing neighbor when only one is given,
// and the write. A renumbering adds one read and one write per row whose
// ordinal changes; its frames reach a collection scope as a `reset` once
// they pass the scope's `bulkThreshold`.

import type { CrudSpec } from "../../../contract/kits/crud";
import type { ReorderInput } from "../../../contract/kits/crudSchemas";
import { QuickdrawError } from "../../../protocol/errors";
import type { StorageWhere } from "../../storage";
import { isOrdinal, ordinalBetween, ORDINAL_STEP } from "./ordinal";
import {
  crudCall,
  delegateOf,
  inTransaction,
  projectionOf,
  type KitHandler,
  type KitHandlerArgs,
  type ModelDelegate,
  type Row,
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

/** Reads the moved row and its named neighbors: `NOT_FOUND` for a missing one, `VALIDATION` for one in another list. */
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
  const find = (id: string | undefined, key: string): Row | undefined => {
    const row = id === undefined ? undefined : byId.get(id);
    if (id !== undefined && row === undefined) {
      throw new QuickdrawError("NOT_FOUND", `No such ${model} as ${key}`);
    }
    return row;
  };
  const moved = find(move.id, "id") as Row;
  const named: Named = {
    moved,
    before: find(move.beforeId, "beforeId"),
    after: find(move.afterId, "afterId"),
  };
  for (const [key, row] of [
    ["beforeId", named.before],
    ["afterId", named.after],
  ] as const) {
    if (row !== undefined && spec.within.some((column) => row[column] !== moved[column])) {
      throw invalid(`${key} is a row of another list`, [key]);
    }
  }
  return named;
}

/** The rows of the moved row's list, the moved row left out. */
function listOf(spec: ReorderSpec, moved: Row): StorageWhere {
  const scope = Object.fromEntries(spec.within.map((column) => [column, moved[column] ?? null]));
  return { AND: [scope, { id: { not: moved.id } }] };
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
): Promise<[low: number | null, high: number | null] | undefined> {
  const { column } = spec;
  const { before, after } = named;
  const list = listOf(spec, named.moved);
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
  spec: ReorderSpec,
  named: Named,
  move: ReorderInput,
): Promise<number> {
  const { column } = spec;
  const rows = await table.findMany({
    where: listOf(spec, named.moved),
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

/** The `reorder` handler. */
export function reorderHandler(spec: ReorderSpec): KitHandler {
  const handler = async ({ input, ctx, db }: KitHandlerArgs): Promise<Row> => {
    const call = crudCall(ctx, db);
    const move = input as ReorderInput;
    const { select } = projectionOf(call, "entity");
    return await inTransaction(db, async (tx) => {
      const table = delegateOf(tx, call.model);
      const named = await readNamed(table, spec, move, call.model);
      const range = await bounds(table, spec, named);
      const between =
        range === undefined
          ? undefined
          : ordinalBetween(range[0] ?? undefined, range[1] ?? undefined);
      const value = between ?? (await renumber(table, spec, named, move));
      return await table.update({ where: { id: move.id }, data: { [spec.column]: value }, select });
    });
  };
  return handler as KitHandler;
}
