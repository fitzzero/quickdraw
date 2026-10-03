// Merging a unit of work's writes per row (RFC 0003 section 5.3, step 1).
// A handler that updates one row ten times flushes one record, so a sink
// reads that row once and a subscriber receives one frame.
//
// Per row, in the order the writes happened:
//
// - A row the unit created and then deleted is dropped: it never existed
//   outside the unit, so no sink, change log or topic hears of it. Its create
//   must be certain: an `upsert` that read nothing (`mayHaveExisted`) may
//   have updated a row that existed, whose delete is kept, with the values
//   the writes carry.
// - Otherwise `delete` beats `create` beats `update`, read as "the row's
//   final state": a row whose last write deleted it is a `delete`; a row
//   that was created, or deleted and created again, is a `create`, which
//   sinks send whole; anything else is an `update`.
// - `fields` are unioned.
// - `before` keeps the earliest value of each column: the row as subscribers
//   last saw it, since nothing was emitted during the unit. A row the unit
//   created has none.
// - `after` keeps the latest value of each column written since the row was
//   last deleted; a deleted row has none.

import { ANY_FIELD, type WriteRecord } from "./types";

type Values = Readonly<Record<string, unknown>>;

/** One row's writes, oldest first. */
type History = readonly [WriteRecord, ...WriteRecord[]];

function mergeFields(history: History): readonly string[] {
  const fields = new Set<string>();
  for (const record of history) {
    for (const field of record.fields) {
      fields.add(field);
    }
  }
  return fields.has(ANY_FIELD) ? [ANY_FIELD] : [...fields];
}

/** Merges value maps; with `keepFirst`, the first value of a key wins, otherwise the last. */
function mergeValues(
  maps: readonly (Values | undefined)[],
  keepFirst: boolean,
): Values | undefined {
  let merged: Record<string, unknown> | undefined;
  for (const values of maps) {
    if (values === undefined) {
      continue;
    }
    merged ??= {};
    for (const [key, value] of Object.entries(values)) {
      if (!keepFirst || !Object.hasOwn(merged, key)) {
        merged[key] = value;
      }
    }
  }
  return merged;
}

function finalOp(history: History): WriteRecord["op"] {
  if (history[history.length - 1]?.op === "delete") {
    return "delete";
  }
  return history.some((record) => record.op === "create") ? "create" : "update";
}

/** The writes since the row was last deleted: what its `after` values describe. */
function sinceLastDelete(history: History): readonly WriteRecord[] {
  let start = 0;
  history.forEach((record, index) => {
    if (record.op === "delete") {
      start = index + 1;
    }
  });
  return history.slice(start);
}

/** True when the row's first write certainly created it: not an upsert that read nothing. */
function created(first: WriteRecord): boolean {
  return first.op === "create" && first.mayHaveExisted !== true;
}

/** The row's one merged record, or `undefined` for a row the unit created and deleted again. */
function mergeRow(history: History): WriteRecord | undefined {
  const [first] = history;
  if (created(first) && history[history.length - 1]?.op === "delete") {
    return undefined;
  }
  if (history.length === 1) {
    return first;
  }
  const op = finalOp(history);
  const before = created(first)
    ? undefined
    : mergeValues(
        history.map((record) => record.before),
        true,
      );
  const after =
    op === "delete"
      ? undefined
      : mergeValues(
          sinceLastDelete(history).map((record) => record.after),
          false,
        );
  return {
    model: first.model,
    id: first.id,
    op,
    fields: mergeFields(history),
    ...(before === undefined ? {} : { before }),
    ...(after === undefined ? {} : { after }),
  };
}

/**
 * Merges a unit of work's writes into one record per row, in the order each
 * row was first written; a row the unit created and deleted again has none.
 * See the rules at the top of this file.
 */
export function mergeRecords(records: readonly WriteRecord[]): WriteRecord[] {
  const rows = new Map<string, [WriteRecord, ...WriteRecord[]]>();
  for (const record of records) {
    const key = `${record.model}\u0000${record.id}`;
    const history = rows.get(key);
    if (history === undefined) {
      rows.set(key, [record]);
    } else {
      history.push(record);
    }
  }
  return [...rows.values()].flatMap((history) => mergeRow(history) ?? []);
}
