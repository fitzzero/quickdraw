// The live entities of one connection and `QueryClient` (RFC 0003 sections 6
// and 11.5): rows subscribed by id, kept current by `qd:e` frames, cached
// under `["qd", service, "e", id]`.
//
// - Subscriptions are counted per row (`registry.ts`): the first holding of
//   a row asks for it, and a tick after the last ends, `qd:unsub` is sent.
// - The rows asked for in one tick go out together: one `qd:sub` per
//   service per microtask, carrying the revision held for each id, at most
//   the server's `maxSubscribeIds` (500) ids each, through the connection's
//   lane. Ported from 4.1's batcher
//   (`legacy-src/client/QuickdrawProvider.tsx:84-163`), which sent no
//   revisions and one event per service.
// - Replies and frames apply by revision (`entities.ts`), and each one's
//   revision is reported to the overlay store, which ends optimistic layers.
// - A batch refused with `RATE_LIMITED` is sent again once the
//   subscription backoff ends; one that got no answer is sent again after
//   5 s while the socket is up, and on the next connect otherwise. Any other
//   refusal is shown on each row and stands until the next connect. Those
//   waits end when the connection closes or no row is held any more.
// - Every connect asks for every held row again with the revision held, so
//   an unchanged row is answered "not modified" and keeps its data.
// - A different user on the connection (`forget`) drops every row and asks
//   for them again without revisions.
//
// React-free: the live data (`liveData.ts`) makes one per connection and
// `QueryClient`, and routes frames to it (`demux.ts`).

import { CLIENT_EVENTS } from "../../contract/names";
import type { QuickdrawError } from "../../protocol/errors";
import { entityKey } from "../keys";
import {
  EMPTY_ENTITY,
  applyEntityFrame,
  applyEntityResult,
  entityResultOf,
  failedEntity,
  heldRevision,
  isEntityFrame,
  revokedEntity,
  type EntityChange,
  type EntityEntry,
} from "./entities";
import {
  chunks,
  limitsOf,
  malformed,
  readEntry,
  request,
  writeEntry,
  type LiveHost,
  type Outcome,
} from "./host";
import { createRegistry, type Registry } from "./registry";

/** The live entities of one connection and `QueryClient`. */
export interface EntityStore {
  /** Holds rows `ids` of `service` for one user of them; returns the release. */
  subscribe(service: string, ids: readonly string[]): () => void;
  /** A `qd:e` frame arrived. */
  receive(frame: unknown): void;
  /** The server ended the subscription to a row (`qd:revoked`). */
  revoked(service: string, id: string): void;
  /** The socket connected: asks for every held row again, with the revisions held. */
  resume(): void;
  /** Another user acts on the connection now: drops every row and asks for each again. */
  forget(): void;
  /** The connection closed: stops every retry. The next connect asks for every held row again. */
  stop(): void;
  /** How many rows are held. */
  size(): number;
}

/** A held row. */
interface Row {
  readonly service: string;
  readonly id: string;
}

interface State {
  readonly host: LiveHost;
  readonly registry: Registry<Row>;
  /** The ids to ask for at the next flush, by service. */
  readonly wanted: Map<string, Set<string>>;
  /** The ids to unsubscribe at the next flush, by service. */
  readonly leaving: Map<string, Set<string>>;
  scheduled: boolean;
  /** Raised by `forget`: answers to batches sent before are dropped. */
  epoch: number;
  /** The waits before batches are sent again. */
  readonly retries: Set<ReturnType<typeof setTimeout>>;
}

/** One `qd:sub` batch in flight. */
interface Batch {
  readonly service: string;
  readonly ids: readonly string[];
  readonly epoch: number;
  /** The overlay clock when it was sent. */
  readonly readAt: number;
}

function rowKey(service: string, id: string): string {
  return `${service}\u0000${id}`;
}

function add(map: Map<string, Set<string>>, service: string, id: string): void {
  const ids = map.get(service) ?? new Set<string>();
  ids.add(id);
  map.set(service, ids);
}

function schedule(state: State): void {
  if (!state.scheduled) {
    state.scheduled = true;
    queueMicrotask(() => {
      flush(state);
    });
  }
}

/** Asks for row `id` at the next flush. */
function want(state: State, service: string, id: string): void {
  state.leaving.get(service)?.delete(id);
  add(state.wanted, service, id);
  schedule(state);
}

function entryOf(state: State, service: string, id: string): EntityEntry {
  return readEntry<EntityEntry>(state.host, entityKey(service, id)) ?? EMPTY_ENTITY;
}

/** Writes a change of row `id`, and asks for the row when the change says so. */
function commit(state: State, row: Row, before: EntityEntry, change: EntityChange<unknown>): void {
  if (change.entry !== before) {
    writeEntry(state.host, entityKey(row.service, row.id), change.entry);
  }
  if (change.request) {
    want(state, row.service, row.id);
  }
}

function heldRow(state: State, service: string, id: string): Row | undefined {
  return state.registry.get(rowKey(service, id));
}

/** Shows `error` on every held row of the batch; their rows stay. */
function refuse(state: State, batch: Batch, error: QuickdrawError): void {
  for (const id of batch.ids) {
    const row = heldRow(state, batch.service, id);
    if (row !== undefined) {
      const before = entryOf(state, row.service, row.id);
      commit(state, row, before, { entry: failedEntity(before, error), request: false });
    }
  }
}

/** Asks for the batch's held rows again after `delayMs`. */
function retry(state: State, batch: Batch, delayMs: number): void {
  const timer = setTimeout(() => {
    state.retries.delete(timer);
    if (batch.epoch !== state.epoch) {
      return;
    }
    for (const id of batch.ids) {
      if (heldRow(state, batch.service, id) !== undefined) {
        want(state, batch.service, id);
      }
    }
  }, delayMs);
  state.retries.add(timer);
}

/** Stops every wait before a batch is sent again. */
function stopRetries(state: State): void {
  for (const timer of state.retries) {
    clearTimeout(timer);
  }
  state.retries.clear();
}

/** Applies each id's answer of a batch, in request order. */
function apply(state: State, batch: Batch, results: readonly unknown[]): void {
  batch.ids.forEach((id, position) => {
    const row = heldRow(state, batch.service, id);
    if (row === undefined) {
      return;
    }
    const result = entityResultOf(results[position]);
    if (result.ok) {
      // A reply: it ends an optimistic layer only when the batch was sent after the call's reply.
      state.host.overlays.observe(row.service, row.id, result.rev, batch.readAt);
    }
    const before = entryOf(state, row.service, row.id);
    commit(state, row, before, applyEntityResult(before, result, batch.readAt));
  });
}

function answered(state: State, batch: Batch, outcome: Outcome): void {
  if (batch.epoch !== state.epoch || outcome.kind === "offline") {
    // Dropped by `forget`, or sent again with every held row on the next connect.
    return;
  }
  if (outcome.kind === "retry") {
    retry(state, batch, outcome.delayMs);
  } else if (outcome.kind === "refused") {
    refuse(state, batch, outcome.error);
  } else if (Array.isArray(outcome.reply.r)) {
    apply(state, batch, outcome.reply.r as readonly unknown[]);
  } else {
    refuse(state, batch, malformed("qd:sub"));
  }
}

/** Sends one `qd:sub` for `ids` of `service`, with the revision held for each. */
function send(state: State, service: string, ids: readonly string[]): void {
  const revs = ids.map((id) => heldRevision(entryOf(state, service, id)));
  const batch: Batch = { service, ids, epoch: state.epoch, readAt: state.host.overlays.now() };
  const frame = revs.some((rev) => rev !== null) ? { s: service, ids, revs } : { s: service, ids };
  request(state.host, CLIENT_EVENTS.sub, frame, (outcome) => {
    answered(state, batch, outcome);
  });
}

function flush(state: State): void {
  state.scheduled = false;
  const { socket } = state.host.connection;
  const { maxSubscribeIds } = limitsOf(state.host);
  for (const [service, ids] of state.leaving) {
    for (const run of socket.connected ? chunks([...ids], maxSubscribeIds) : []) {
      socket.emit(CLIENT_EVENTS.unsub, { s: service, ids: run });
    }
  }
  state.leaving.clear();
  const wanted = [...state.wanted];
  state.wanted.clear();
  if (!socket.connected) {
    // Every held row is asked for on the next connect.
    return;
  }
  for (const [service, ids] of wanted) {
    const held = [...ids].filter((id) => heldRow(state, service, id) !== undefined);
    for (const run of chunks(held, maxSubscribeIds)) {
      send(state, service, run);
    }
  }
}

function receive(state: State, frame: unknown): void {
  if (!isEntityFrame(frame)) {
    return;
  }
  const row = heldRow(state, frame.s, frame.id);
  if (row === undefined) {
    return;
  }
  state.host.overlays.observe(row.service, row.id, frame.rev);
  const before = entryOf(state, row.service, row.id);
  commit(state, row, before, applyEntityFrame(before, frame));
}

/** Creates the live entities of `host`. */
export function createEntityStore(host: LiveHost): EntityStore {
  const state: State = {
    host,
    registry: createRegistry<Row>((row) => {
      state.wanted.get(row.service)?.delete(row.id);
      add(state.leaving, row.service, row.id);
      schedule(state);
      if (state.registry.held().length === 0) {
        stopRetries(state);
      }
    }),
    wanted: new Map(),
    leaving: new Map(),
    scheduled: false,
    epoch: 0,
    retries: new Set(),
  };
  return Object.freeze({
    subscribe(service: string, ids: readonly string[]): () => void {
      const holdings = [...new Set(ids)].map((id) => {
        const holding = state.registry.acquire(rowKey(service, id), () => ({ service, id }));
        if (holding.isNew) {
          want(state, service, id);
        }
        return holding;
      });
      return () => {
        for (const holding of holdings) {
          holding.release();
        }
      };
    },
    receive: (frame: unknown) => {
      receive(state, frame);
    },
    revoked(service: string, id: string): void {
      const row = heldRow(state, service, id);
      if (row !== undefined) {
        const before = entryOf(state, service, id);
        commit(state, row, before, { entry: revokedEntity(before), request: false });
      }
    },
    resume(): void {
      for (const row of state.registry.held()) {
        want(state, row.service, row.id);
      }
    },
    forget(): void {
      state.epoch += 1;
      for (const row of state.registry.held()) {
        writeEntry(state.host, entityKey(row.service, row.id), EMPTY_ENTITY);
        want(state, row.service, row.id);
      }
    },
    stop(): void {
      stopRetries(state);
    },
    size: () => state.registry.held().length,
  });
}
