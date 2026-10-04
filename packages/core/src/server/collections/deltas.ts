// A flush's deltas per scope (RFC 0003 section 7.2): every move of the flush
// that concerns a scope, in the order the rows were first written, batched
// into the one frame the scope gets for the flush. More rows than the
// collection's `bulkThreshold` for one scope make that frame a single
// `reset`, read nothing, and let its clients load the scope again. 4.1 sent
// one event per row per scope (`legacy-src/server/collections.ts:338-352`)
// and left bulk writes to a hand-written `emitReset`.
//
// Items come from rows the moves already read, or from one read for the
// rest, with the item's select (only the patched fields when every delta is
// a patch). A row read as missing was deleted since: its own flush removes
// it, so its `added` or `updated` is dropped here.
//
// In a collection that declares `index`, an `added` delta also carries its
// member's index row, built from the item it sends (`index.ts`), with the
// service's `versionColumn` read alongside the item for the row's `rev`.
//
// Behind a cluster adapter (`whole`) a change that would be `patched` goes
// out `updated`, with the whole item: frames from two nodes can reach a
// client out of revision order, and a patch it dropped as older would lose
// its fields. One that would be dropped as empty is still dropped.

import { collectionRoom } from "../../contract/names";
import type { CollectionDelta, Revision } from "../../protocol/envelope";
import { selectFor, type FrameKind } from "../emit/frames";
import type { StorageAdapter, StorageRow } from "../storage";
import type { BoundCollection } from "./bind";
import { indexColumns, indexRowFrom } from "./index";
import { itemOf, patchOf, selectWith } from "./items";
import type { Moves } from "./moves";

/** A delta whose item is not read yet. */
type Pending =
  | { readonly t: "removed" | "added" | "updated"; readonly id: string }
  | { readonly t: "patched"; readonly id: string; readonly fields: readonly string[] };

/** What one scope gets from one flush. */
export interface ScopePlan {
  readonly scope: string;
  readonly room: string;
  readonly deltas: Pending[];
  /** Too many rows changed, or junction rows went unseen: one `reset` instead. */
  reset: boolean;
}

/**
 * The plan of every scope the moves concern, in the order rows were first
 * written. `subscribed` are the collection's scopes with subscribers on this
 * process: a row that left scopes nobody can name is removed from them.
 */
export function planScopes(
  collection: BoundCollection,
  moves: Moves,
  subscribed: readonly string[],
): ScopePlan[] {
  const plans = new Map<string, ScopePlan>();
  const planOf = (scope: string): ScopePlan => {
    let plan = plans.get(scope);
    if (plan === undefined) {
      const room = collectionRoom(collection.service.name, collection.name, scope);
      plan = { scope, room, deltas: [], reset: false };
      plans.set(scope, plan);
    }
    return plan;
  };
  for (const move of moves.moves) {
    const { id, kind } = move;
    for (const scope of move.left) {
      planOf(scope).deltas.push({ t: "removed", id });
    }
    for (const scope of move.entered) {
      planOf(scope).deltas.push({ t: "added", id });
    }
    for (const scope of move.stayed) {
      planOf(scope).deltas.push(
        kind.t === "p" ? { t: "patched", id, fields: kind.fields } : { t: "updated", id },
      );
    }
    const named = new Set([...move.left, ...move.entered, ...move.stayed]);
    for (const scope of move.unknownLeft ? subscribed : []) {
      if (!named.has(scope)) {
        planOf(scope).deltas.push({ t: "removed", id });
      }
    }
  }
  for (const scope of moves.resetAll ? subscribed : []) {
    planOf(scope).reset = true;
  }
  for (const plan of plans.values()) {
    plan.reset ||= plan.deltas.length > collection.bulkThreshold;
  }
  return [...plans.values()];
}

/**
 * The rows the plans' deltas take items from: those the moves read, and one
 * read for the others; whole items for every change when `wholeItems`.
 */
export async function readItems(
  storage: StorageAdapter,
  collection: BoundCollection,
  plans: readonly ScopePlan[],
  read: ReadonlyMap<string, StorageRow>,
  wholeItems = false,
): Promise<ReadonlyMap<string, StorageRow>> {
  const kinds = new Map<string, FrameKind>();
  for (const plan of plans.filter(({ reset }) => !reset)) {
    for (const delta of plan.deltas) {
      if (delta.t === "removed" || read.has(delta.id)) {
        continue;
      }
      const item = wholeItems || delta.t !== "patched" || kinds.get(delta.id)?.t === "u";
      kinds.set(delta.id, item ? { t: "u" } : { t: "p", fields: delta.fields });
    }
  }
  if (kinds.size === 0) {
    return read;
  }
  const select = selectFor(collection.item, [...kinds.values()]);
  const whole = [...kinds.values()].some((kind) => kind.t === "u");
  const rows = await storage.findMany(collection.model, {
    where: { id: { in: [...kinds.keys()] } },
    select: whole ? selectWith(select, indexColumns(collection)) : select,
  });
  const all = new Map(read);
  for (const row of rows) {
    if (typeof row.id === "string") {
      all.set(row.id, row);
    }
  }
  return all;
}

/** An `added` delta: the member's item, and in an indexed collection its index row, built from that item. */
function added(collection: BoundCollection, row: StorageRow, rev: Revision): CollectionDelta {
  const item = itemOf(collection, row);
  return collection.index === undefined
    ? { t: "added", item }
    : { t: "added", item, index: indexRowFrom(collection, item, row, rev) };
}

/**
 * The deltas of one scope's frame for the flush at `rev`, from its plan and
 * the rows read; `whole` sends `updated` items where a patch would go.
 */
export function buildDeltas(
  collection: BoundCollection,
  plan: ScopePlan,
  rows: ReadonlyMap<string, StorageRow>,
  rev: Revision,
  whole = false,
): CollectionDelta[] {
  if (plan.reset) {
    return [{ t: "reset" }];
  }
  const deltas: CollectionDelta[] = [];
  for (const delta of plan.deltas) {
    const row = rows.get(delta.id);
    if (delta.t === "removed") {
      deltas.push({ t: "removed", id: delta.id });
      continue;
    }
    if (row === undefined) {
      continue;
    }
    if (delta.t === "patched") {
      const d = patchOf(collection, row, delta.fields);
      if (Object.keys(d).length > 0) {
        deltas.push(
          whole
            ? { t: "updated", item: itemOf(collection, row) }
            : { t: "patched", id: delta.id, d },
        );
      }
      continue;
    }
    deltas.push(
      delta.t === "added"
        ? added(collection, row, rev)
        : { t: "updated", item: itemOf(collection, row) },
    );
  }
  return deltas;
}
