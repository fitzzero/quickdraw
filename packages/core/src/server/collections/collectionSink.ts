// The collection sink (RFC 0003 sections 5.3 and 7.2): what a flush does for
// collection subscribers. It goes after the access and entity sinks on the
// dispatcher's list, so a socket a flush revoked never gets its deltas. It
// replaces 4.1's `notify` (`legacy-src/server/collections.ts:205-270`), which
// only `this.create/update/delete` called, after reading the whole row first
// (`legacy-src/server/BaseService.ts:741-751`).
//
// Per flush:
//
// 1. close the scopes anchored on rows the flush deleted (`send.ts`);
// 2. per collection the writes concern (its model, its `via` junction, or an
//    `affects` hop onto its service), find each row's moves (`moves.ts`),
//    reading only rows whose write does not carry the values that decide
//    membership;
// 3. per scope, batch the moves' deltas into one plan, or one `reset` past
//    `bulkThreshold` (`deltas.ts`);
// 4. leave out scopes nobody here subscribes to, which raises their resume
//    floor instead; behind a cluster adapter other nodes' rooms are not
//    visible, so every scope is sent;
// 5. read the items the remaining deltas need, in one query per collection,
//    and send one `qd:c` frame per scope, which the resume buffer keeps.
//
// A collection with no subscriber on this process (and rooms visible here)
// skips steps 2 to 5 and reads nothing (`skipTouched`).
//
// A failure sends a `reset` to the touched scopes and is rethrown to be
// logged; another sink's failure does the same through `onFlushError`.

import { touchedRows, type TouchedRows } from "../emit/affects";
import { modelKey, type StorageAdapter } from "../storage";
import type { FlushInfo, FlushSink } from "../uow/flushSink";
import type { WriteRecord } from "../uow/types";
import type { BoundCollection, CollectionHub } from "./bind";
import { buildDeltas, planScopes, readItems, type ScopePlan } from "./deltas";
import { columnMoves, viaMoves } from "./moves";
import { closeAnchors, resetTouched, sendFrame, skipTouched } from "./send";

type Io = NonNullable<CollectionHub["io"]>;

/** One collection's share of a flush. */
interface Work {
  readonly collection: BoundCollection;
  /** Rows of its service only an `affects` hop touched: their items are sent again. */
  readonly refresh: readonly string[];
}

/** The collections the flush concerns, with the rows of each that only an `affects` hop touched. */
function workOf(hub: CollectionHub, writes: readonly WriteRecord[], touched: TouchedRows): Work[] {
  const { routes } = hub.collections;
  const concerned = new Set<BoundCollection>();
  for (const write of writes) {
    const key = modelKey(write.model);
    for (const collection of [
      ...(routes.byModel.get(key) ?? []),
      ...(routes.byJunction.get(key) ?? []),
    ]) {
      concerned.add(collection);
    }
  }
  for (const service of touched.keys()) {
    for (const name of service.collections.keys()) {
      const collection = routes.find(service.name, name);
      if (collection !== undefined) {
        concerned.add(collection);
      }
    }
  }
  return [...concerned].map((collection) => {
    const written = new Set(
      writes.filter((write) => modelKey(write.model) === collection.model).map(({ id }) => id),
    );
    const rows = touched.get(collection.service)?.keys() ?? [];
    return { collection, refresh: [...rows].filter((id) => !written.has(id)) };
  });
}

/** True when a socket of this process is in the room, or rooms cannot be seen here (a cluster adapter). */
function occupied(hub: CollectionHub, io: Io, room: string): boolean {
  return !hub.probe.local() || (io.sockets.adapter.rooms.get(room)?.size ?? 0) > 0;
}

/** Steps 2 to 5 for one collection. */
async function emitCollection(
  hub: CollectionHub,
  io: Io,
  storage: StorageAdapter,
  work: Work,
  writes: readonly WriteRecord[],
  rev: number,
  closed: ReadonlySet<string>,
): Promise<void> {
  const { collection, refresh } = work;
  const subscribed = hub.collections.scopes.scopes(collection.service.name, collection.name);
  if (subscribed.length === 0 && hub.probe.local()) {
    skipTouched(hub, collection, writes, refresh, rev);
    return;
  }
  const moves =
    collection.scope.kind === "column"
      ? await columnMoves(storage, collection, writes, refresh)
      : await viaMoves(storage, collection, writes, refresh);
  const sending: ScopePlan[] = [];
  for (const plan of planScopes(collection, moves, subscribed)) {
    if (closed.has(plan.room)) {
      continue;
    }
    if (occupied(hub, io, plan.room)) {
      sending.push(plan);
    } else {
      hub.collections.buffer.skip(plan.room, rev);
    }
  }
  if (sending.length === 0) {
    return;
  }
  const rows = await readItems(storage, collection, sending, moves.rows);
  for (const plan of sending) {
    sendFrame(hub, io, collection, plan.scope, rev, buildDeltas(collection, plan, rows));
  }
}

async function emitFlush(
  hub: CollectionHub,
  io: Io,
  storage: StorageAdapter,
  writes: readonly WriteRecord[],
  rev: number,
): Promise<void> {
  const closed = closeAnchors(hub, io, writes, rev);
  const work = workOf(hub, writes, touchedRows(writes, hub.routes));
  await Promise.all(work.map((one) => emitCollection(hub, io, storage, one, writes, rev, closed)));
}

/** The collection sink of a dispatcher. */
export function createCollectionSink(hub: CollectionHub): FlushSink {
  return Object.freeze({
    async flush(writes: readonly WriteRecord[], info: FlushInfo): Promise<void> {
      const { io, storage } = hub;
      if (io === undefined || storage === undefined) {
        return;
      }
      try {
        await emitFlush(hub, io, storage, writes, info.rev);
      } catch (error) {
        resetTouched(hub, io, writes, info.rev);
        throw error;
      }
    },
    onFlushError(writes: readonly WriteRecord[], info: FlushInfo): void {
      if (hub.io !== undefined) {
        resetTouched(hub, hub.io, writes, info.rev);
      }
    },
  });
}
