// A flush's deltas per scope (RFC 0003 section 7.2): every move of the flush
// that concerns a scope, in the order the rows were first written, batched
// into the one frame the scope gets for the flush. More rows than the
// collection's `bulkThreshold` for one scope make that frame a single
// `reset`, read nothing, and let its clients load the scope again. 4.1 sent
// one event per row per scope (4.1 `src/server/collections.ts:338-352`)
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
// Behind a cluster adapter (`cluster`) a change that would be `patched` goes
// out `updated`, with the whole item: frames from two nodes can reach a
// client out of revision order, and a patch it dropped as older would lose
// its fields. One that would be dropped as empty is still dropped.
//
// Behind a cluster adapter each delta is also decided by its row as read
// for the frame, not by the write's own values alone. A flush takes its
// revision when it flushes, after its handler settled and (behind a
// cluster) once the counter answered, so a write that committed first can
// flush last: a move out of a scope, or a delete, then carries a higher
// revision than a later move back in, or a later create of its id, and a
// client would apply it over them. The read is made after the flush took
// its revision, so it sees every write whose flush took a lower one: a row
// in the scope at the read goes out (`removed` becomes `updated`, or
// `added` for a row that left scopes nobody could name), and one that is
// not there is `removed`. Every frame a scope gets about a row is then right
// as of a read made after its revision, and the newest one wins on the
// client. The rows of `removed` deltas are read for it, with the membership
// columns. One server keeps its cheaper rule (no read for a removal): a
// write that commits first and flushes last can still leave a client
// without a member there until the row's next write.

import { collectionRoom } from "../../contract/names";
import type { CollectionDelta, Revision } from "../../protocol/envelope";
import { selectFor, type FrameKind } from "../emit/frames";
import type { StorageAdapter, StorageRow } from "../storage";
import type { BoundCollection } from "./bind";
import { indexColumns, indexRowFrom } from "./index";
import { itemOf, membershipColumns, patchOf, scopeIn, selectWith } from "./items";
import type { Moves } from "./moves";

/** A delta whose item is not read yet. */
type Pending =
  | { readonly t: "added" | "updated"; readonly id: string }
  | {
      readonly t: "removed";
      readonly id: string;
      /** The row left scopes nobody could name: this scope may never have held it. */
      readonly unnamed?: true;
    }
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
        planOf(scope).deltas.push({ t: "removed", id, unnamed: true });
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

const WHOLE: FrameKind = Object.freeze({ t: "u" });

/**
 * The rows the plans' deltas take items from: those the moves read, and one
 * read for the others. Behind a cluster adapter (`cluster`) every change
 * reads its whole item, and the rows of `removed` deltas and of `also` are
 * read too, with the membership columns, so the deltas are decided at the
 * read (`buildDeltas`).
 */
export async function readItems(
  storage: StorageAdapter,
  collection: BoundCollection,
  plans: readonly ScopePlan[],
  read: ReadonlyMap<string, StorageRow>,
  cluster = false,
  also: readonly string[] = [],
): Promise<ReadonlyMap<string, StorageRow>> {
  const kinds = new Map<string, FrameKind>();
  for (const plan of plans.filter(({ reset }) => !reset)) {
    for (const delta of plan.deltas) {
      if (read.has(delta.id) || (delta.t === "removed" && !cluster)) {
        continue;
      }
      const item = cluster || delta.t !== "patched" || kinds.get(delta.id)?.t === "u";
      kinds.set(delta.id, item ? WHOLE : { t: "p", fields: delta.fields });
    }
  }
  for (const id of cluster ? also : []) {
    if (!read.has(id)) {
      kinds.set(id, WHOLE);
    }
  }
  if (kinds.size === 0) {
    return read;
  }
  const select = selectFor(collection.item, [...kinds.values()]);
  const whole = [...kinds.values()].some((kind) => kind.t === "u");
  const columns = [...indexColumns(collection), ...(cluster ? membershipColumns(collection) : [])];
  const rows = await storage.findMany(collection.model, {
    where: { id: { in: [...kinds.keys()] } },
    select: whole ? selectWith(select, columns) : select,
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
 * Behind a cluster adapter, a pending delta of `scope` as the row read for
 * the frame decides it (`row` absent: the row is gone). In a column-scoped
 * collection a row not in the scope at the read is `removed`, and one in it
 * is not: a removal becomes `updated` (`added` for a row that left scopes
 * nobody could name, which this scope may never have held). A `via` scope's
 * links were already read at flush time (`moves.ts`), so there only a row
 * gone since is `removed`.
 */
function decided(
  collection: BoundCollection,
  scope: string,
  pending: Pending,
  row: StorageRow | undefined,
): Pending {
  if (collection.scope.kind !== "column") {
    return row === undefined && pending.t !== "removed"
      ? { t: "removed", id: pending.id }
      : pending;
  }
  if (row === undefined || scopeIn(collection, row) !== scope) {
    return pending.t === "removed" ? pending : { t: "removed", id: pending.id };
  }
  if (pending.t !== "removed") {
    return pending;
  }
  return { t: pending.unnamed === true ? "added" : "updated", id: pending.id };
}

/**
 * The deltas of one scope's frame for the flush at `rev`, from its plan and
 * the rows read. Behind a cluster adapter (`cluster`) each delta is decided
 * by its row as read (`decided`), and goes out `updated`, whole, where a
 * patch would go.
 */
export function buildDeltas(
  collection: BoundCollection,
  plan: ScopePlan,
  rows: ReadonlyMap<string, StorageRow>,
  rev: Revision,
  cluster = false,
): CollectionDelta[] {
  if (plan.reset) {
    return [{ t: "reset" }];
  }
  const deltas: CollectionDelta[] = [];
  for (const pending of plan.deltas) {
    const row = rows.get(pending.id);
    const delta = cluster ? decided(collection, plan.scope, pending, row) : pending;
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
          cluster
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
