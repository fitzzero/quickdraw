// Ordinals for the read/write kit's `reorder` (RFC 0003 section 12.1): rows
// are kept apart by gaps of `ORDINAL_STEP`, so a row moves between two others
// by taking the whole number halfway between them, and only that row is
// written. When no whole number is left between them (about ten moves into
// one gap), the ordered list is renumbered in steps. Whole numbers suit
// `Int` and `Float` columns alike, and stay within a 32-bit integer.

import type { StorageWhere } from "../../storage";
import { delegateOf } from "./runtime";

/** The gap between the ordinals of neighboring rows, after a renumbering and for `nextOrdinal`. */
export const ORDINAL_STEP = 1024;

const MIN_ORDINAL = -2_147_483_648;
const MAX_ORDINAL = 2_147_483_647;

/** A number an ordinal column may hold: finite, and within a 32-bit integer. */
export function isOrdinal(value: unknown): value is number {
  return (
    typeof value === "number" &&
    Number.isFinite(value) &&
    value >= MIN_ORDINAL &&
    value <= MAX_ORDINAL
  );
}

/**
 * A whole number strictly between `low` and `high`, a step below `high` when
 * there is no `low` (the start of the list), a step above `low` when there is
 * no `high` (its end); `undefined` when there is none left.
 */
export function ordinalBetween(
  low: number | undefined,
  high: number | undefined,
): number | undefined {
  let value: number | undefined;
  if (low === undefined && high !== undefined) {
    value = Math.ceil(high) - ORDINAL_STEP;
  } else if (high === undefined && low !== undefined) {
    value = Math.floor(low) + ORDINAL_STEP;
  } else if (low !== undefined && high !== undefined) {
    const middle = Math.floor((low + high) / 2);
    value = middle > low && middle < high ? middle : undefined;
  }
  return isOrdinal(value) ? value : undefined;
}

/** Options of {@link nextOrdinal}. */
export interface NextOrdinalOptions {
  /** The ordinal column. Default `"ordinal"`. */
  readonly column?: string;
}

/**
 * The ordinal that puts a new row last among the rows `where` matches: a step
 * after the highest, or one step for an empty list. One statement. For a
 * create handler (or `crud.handlers`' `prepare`) of a model the kit's
 * `reorder` orders.
 *
 * @example
 * const ordinal = await nextOrdinal(db, "task", { projectId: input.projectId });
 * return db.task.create({ data: { ...input, ordinal } });
 */
export async function nextOrdinal(
  db: unknown,
  model: string,
  where: StorageWhere = {},
  options: NextOrdinalOptions = {},
): Promise<number> {
  const column = options.column ?? "ordinal";
  if (typeof model !== "string" || model.length === 0 || column.length === 0) {
    throw new TypeError(
      "nextOrdinal(db, model, where, { column? }): name the model and its column",
    );
  }
  const result = await delegateOf(db, model).aggregate({ where, _max: { [column]: true } });
  const highest = (result._max as Readonly<Record<string, unknown>> | null | undefined)?.[column];
  return typeof highest === "number" && Number.isFinite(highest)
    ? Math.floor(highest) + ORDINAL_STEP
    : ORDINAL_STEP;
}
