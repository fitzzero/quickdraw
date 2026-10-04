// The change topics a flush changed (RFC 0003 sections 5.3 and 11.3), and the
// sink that tells their watchers: `qd:changed { s, topic, rev }`, once per
// flush per topic, to the topic's room. It carries no data; a client
// invalidates the queries that watch the topic and reads them again. It
// replaces 4.1's `invalidateOn`, which named hand-written events.
//
// Per flush:
//
// - the service topic of every service the flush changed: one of its rows
//   (written, touched, or reached by an `affects` hop), a junction link of
//   one of its `via` collections, a row of a model it lists in `writes` (a
//   game's high scores: a query over them watches the service), or a scope
//   it lost when the row it was anchored on was deleted;
// - the topic of every collection scope a touched row was in before or after
//   the flush, from the same moves the collection sink finds (`moves.ts`,
//   shared, so a flush reads their rows once); a row that left scopes nobody
//   can name, or junction rows removed without values, change every scope
//   watched here; and a scope closed by deleting its anchor row changed too.
//
// Only topics a socket here watches are computed, and a collection none of
// whose topics is watched here reads nothing. Behind a cluster adapter other
// nodes' rooms are not visible, so every changed topic is sent.
//
// A failure while finding the moves still tells the watchers: every topic
// watched here that the flush may have changed gets `qd:changed`, and the
// error is rethrown to be logged.

import { collectionTopic, SERVER_EVENTS, SERVICE_TOPIC, topicRoom } from "../../contract/names";
import type { ChangedFrame, Revision } from "../../protocol/envelope";
import { touchedRows, type TouchedRows } from "../emit/affects";
import { modelKey, type StorageAdapter } from "../storage";
import type { TopicIndex } from "../topicIndex";
import type { FlushInfo, FlushSink } from "../uow/flushSink";
import type { WriteRecord } from "../uow/types";
import { anchoredScopes, type BoundCollection, type CollectionHub } from "./bind";
import { workOf } from "./collectionSink";
import { movesOf, type Moves } from "./moves";

type Io = NonNullable<CollectionHub["io"]>;

/** The `qd:changed` frames of one flush, by topic room: one per topic. */
type Frames = Map<string, ChangedFrame>;

/** Per model (`modelKey`), the services that list it in their `writes`. */
type Writers = ReadonlyMap<string, readonly BoundCollection["service"][]>;

/** What finding a flush's topics needs. */
interface Flush {
  readonly hub: CollectionHub;
  readonly index: TopicIndex;
  readonly writers: Writers;
  readonly writes: readonly WriteRecord[];
  readonly touched: TouchedRows;
  readonly rev: Revision;
  /** Whether every subscriber is a socket of this process (no cluster adapter). */
  readonly local: boolean;
  readonly frames: Frames;
}

function mark(flush: Flush, s: string, topic: string): void {
  flush.frames.set(topicRoom(s, topic), { s, topic, rev: flush.rev });
}

/** Marks one collection scope's topic when it may be watched: here, or anywhere behind a cluster adapter. */
function markScope(flush: Flush, collection: BoundCollection, scope: string): void {
  const s = collection.service.name;
  if (!flush.local || flush.index.watchesScope(s, collection.name, scope)) {
    mark(flush, s, collectionTopic(collection.name, scope));
  }
}

/** The services that list each model in their `writes`, by `modelKey`. */
function writersOf(hub: CollectionHub): Writers {
  const writers = new Map<string, BoundCollection["service"][]>();
  for (const service of hub.registry.services.values()) {
    for (const model of service.writes) {
      const key = modelKey(model);
      writers.set(key, [...(writers.get(key) ?? []), service]);
    }
  }
  return writers;
}

/**
 * The services whose rows or collection scopes the flush changed, and those
 * that list a written model in their `writes` (a query over such a model
 * watches the writing service's topic).
 */
function changedServices(flush: Flush): Set<BoundCollection["service"]> {
  const services = new Set(flush.touched.keys());
  const { routes } = flush.hub.collections;
  for (const write of flush.writes) {
    const key = modelKey(write.model);
    for (const collection of routes.byJunction.get(key) ?? []) {
      services.add(collection.service);
    }
    for (const writer of flush.writers.get(key) ?? []) {
      services.add(writer);
    }
  }
  for (const [collection] of anchoredScopes(routes, flush.writes)) {
    services.add(collection.service);
  }
  return services;
}

/** Marks the service topics and the scopes closed by a deleted anchor row: neither needs a read. */
function markUnread(flush: Flush): void {
  for (const service of changedServices(flush)) {
    if (!flush.local || flush.index.watchesService(service.name)) {
      mark(flush, service.name, SERVICE_TOPIC);
    }
  }
  for (const [collection, scope] of anchoredScopes(flush.hub.collections.routes, flush.writes)) {
    markScope(flush, collection, scope);
  }
}

/** The scopes one collection's moves changed: every scope a row left, entered or changed in. */
function scopesOf(moves: Moves, watched: ReadonlySet<string>): Set<string> {
  const scopes = new Set<string>();
  for (const move of moves.moves) {
    for (const scope of [...move.left, ...move.entered, ...move.stayed]) {
      scopes.add(scope);
    }
    for (const scope of move.unknownLeft ? watched : []) {
      scopes.add(scope);
    }
  }
  for (const scope of moves.resetAll ? watched : []) {
    scopes.add(scope);
  }
  return scopes;
}

/** Finds the topics `writes` changed, reading what their collections' moves need. */
async function findTopics(flush: Flush, storage: StorageAdapter): Promise<void> {
  markUnread(flush);
  const { hub, writes } = flush;
  await Promise.all(
    workOf(hub, writes, flush.touched).map(async ({ collection, refresh }) => {
      const watched = flush.index.scopes(collection.service.name, collection.name);
      if (flush.local && watched.size === 0) {
        return;
      }
      const moves = await movesOf(
        hub.collections.moves,
        storage,
        collection,
        writes,
        refresh,
        !flush.local,
      );
      for (const scope of scopesOf(moves, watched)) {
        markScope(flush, collection, scope);
      }
    }),
  );
}

/** Marks every watched topic the flush may have changed, without reading: the moves could not be found. */
function markWatched(flush: Flush): void {
  markUnread(flush);
  for (const { collection } of workOf(flush.hub, flush.writes, flush.touched)) {
    for (const scope of flush.index.scopes(collection.service.name, collection.name)) {
      markScope(flush, collection, scope);
    }
  }
}

function send(io: Io, frames: Frames): void {
  for (const [room, frame] of frames) {
    io.to(room).emit(SERVER_EVENTS.changed, frame);
  }
}

/** The topic sink of a dispatcher: after the collection sink on the dispatcher's list. */
export function createTopicSink(hub: CollectionHub, index: TopicIndex): FlushSink {
  const writers = writersOf(hub);
  return Object.freeze({
    async flush(writes: readonly WriteRecord[], info: FlushInfo): Promise<void> {
      const { io, storage } = hub;
      if (io === undefined || storage === undefined) {
        return;
      }
      const flush: Flush = {
        hub,
        index,
        writers,
        writes,
        touched: touchedRows(writes, hub.routes),
        rev: info.rev,
        local: hub.probe.local(),
        frames: new Map(),
      };
      try {
        await findTopics(flush, storage);
      } catch (error) {
        markWatched(flush);
        throw error;
      } finally {
        send(io, flush.frames);
      }
    },
  });
}
