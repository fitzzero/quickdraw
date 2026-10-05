// One collection scope's live pipeline (RFC 0003 sections 7.2 to 7.4 and
// 11.5), shared by every hook that shows the scope, so they drive one load
// and one page at a time. Ported from 4.1's per-key controller
// (4.1 `src/client/useCollection.ts:136-269`), with these changes:
//
// - Loading the scope again resumes it: `qd:col:sub` carries `since`, the
//   newest revision applied, and a `resumed` answer brings the deltas missed
//   meanwhile, applied in the order sent. Any other answer is a snapshot,
//   applied as one; items loaded before and not on its page are then loaded
//   again by id, since they may have changed. While `load: "all"` reads
//   every page again instead, the items of a scope without an index that
//   none of those pages refreshed are dropped once the last page is read:
//   they left the scope while it was not followed.
// - Frames that arrive while a load is in flight are kept and applied on top
//   of its answer, each at its own revision (4.1 did this for snapshots,
//   `:191-218`).
// - `reset` loads the scope again after a random 100 to 2,000 ms, so the
//   clients of a bulk write do not all ask at once (4.1 waited a fixed
//   100 ms, `:17`).
// - `loadMore` reads the next page by cursor; a load of the scope that
//   starts meanwhile cancels it (its answer is dropped). `load: "all"` reads
//   pages until the cursor is `null`.
// - `loadItems(ids)` loads items by id with `qd:col:items`, at most 200 per
//   request, once the scope is joined; a patch for an item not held loads
//   it that way.
// - `keep(items, rev)` takes items of the scope read elsewhere (a search's
//   results) into the state by revision, as if loaded by id, so the scope's
//   deltas keep them current.
// - `qd:revoked` drops the state: access was revoked (`FORBIDDEN`) or the
//   scope's anchor row was deleted (`NOT_FOUND`).
// - A scope whose load was refused stays refused until a connect, or until
//   the hub learns the user's access may have changed and refreshes it
//   (`collections.ts`; finding F8.4 of the quickdraw-chat migration).
// - Each new state tells the overlay store what it means for the items
//   optimistic updates added to the scope (`settleAdditions`): one whose
//   server id the state holds, or a delta named, or that a load sent after
//   its call's reply answered without, ends.
// - Requests go through the connection's lane. `RATE_LIMITED` waits out the
//   subscription backoff; a request without an answer is sent again after
//   5 s while the socket is up; with the socket down, the next connect
//   resumes the scope.
//
// The state lives in the cache under `["qd", service, "c", collection,
// scope]` (`host.ts`). React-free.

import { DEFAULT_COLLECTION_MAX_LIMIT } from "../../contract/collections";
import { CLIENT_EVENTS } from "../../contract/names";
import type { CollectionFrame, Revision, RevokeReason } from "../../protocol/envelope";
import { QuickdrawError } from "../../protocol/errors";
import { collectionKey, type CollectionQueryKey } from "../keys";
import { settleAdditions, type ScopeEvidence } from "../optimistic";
import {
  endWaits,
  isPage,
  loadItems,
  loadPage,
  observeItems,
  type CollectionEntry,
  type CollectionTarget,
  type LoadSteps,
} from "./collectionLoads";
import {
  applyDeltas,
  applyFrames,
  applyKept,
  applySnapshot,
  pruneStale,
  staleIds,
  type CollectionState,
  type DeltaBatch,
  type DeltaResult,
} from "./collectionStore";
import {
  isRevision,
  malformed,
  readEntry,
  request,
  writeEntry,
  type LiveHost,
  type Outcome,
} from "./host";

export type { CollectionEntry, CollectionTarget };

/** The shortest and longest wait before a scope is loaded again after `reset`. */
export const RESET_DELAY_MS = Object.freeze({ min: 100, max: 2000 });

/** Why a scope is loaded again: the socket connected, or a check (tab visible again, idle timer). */
export type ResumeReason = "connect" | "check";

/** One collection scope's pipeline. */
export interface CollectionController {
  readonly key: CollectionQueryKey;
  /** Loads the scope for the first time. */
  start(): void;
  /** A `qd:c` frame of the scope arrived. */
  receive(frame: CollectionFrame): void;
  /** The server ended the subscription (`qd:revoked`). */
  revoked(reason: RevokeReason): void;
  /** Loads the scope again from the revision held: on a connect, or as a check. */
  resume(reason: ResumeReason): void;
  /** Loads the scope again from scratch; resolves once that load settled. */
  refresh(): Promise<void>;
  /** The scope's value: the id of the row it is anchored on, for a scope that has one. */
  readonly scope: string;
  /** Loads the next page, if there is one. */
  loadMore(): Promise<void>;
  /** Loads the items of `ids` by id. Rejects with the server's error when it refuses. */
  loadItems(ids: readonly string[]): Promise<void>;
  /** Loads every page of the scope while the returned release is not called. */
  loadAll(): () => void;
  /**
   * Keeps items of the scope read outside it at revision `rev` (a search's
   * results) in its state, unless it holds something newer, so its deltas
   * keep them current; a member whose newer revision it holds without an
   * item is loaded by id instead. Returns false, keeping nothing, until the
   * scope's state is loaded.
   */
  keep(items: readonly unknown[], rev: Revision): boolean;
  /** Another user acts on the connection now: drops the state and loads the scope from scratch. */
  forget(): void;
  /** The connection closed: stops every timer and wait. The next connect loads the scope again. */
  stop(): void;
  /** Ends the subscription: `qd:col:unsub`, every request in flight is dropped, and no timer is left. */
  dispose(): void;
}

/** A controller's state. */
interface Pipeline extends LoadSteps {
  /** The generation of the load in flight; frames are kept meanwhile. */
  loading: number | undefined;
  buffered: DeltaBatch[];
  resetTimer: ReturnType<typeof setTimeout> | undefined;
  retryTimer: ReturnType<typeof setTimeout> | undefined;
  /** True while the server has the socket in the scope's room. */
  joined: boolean;
  /** Waiting for the next load to settle: `refresh`, and `loadItems` before the scope is joined. */
  readonly settled: Set<(error: QuickdrawError | null) => void>;
  /** How many users load every page. */
  allDemand: number;
  /** True while `load: "all"` is reading pages. */
  allLoop: boolean;
  /** Set when the reader is asked to read again while it reads. */
  allAgain: boolean;
  /** A snapshot replaced a loaded state while every page is read: prune what the pages do not bring back. */
  pruneAfterPages: boolean;
  /** Item ids patches found missing, loaded at the next microtask. */
  readonly missing: Set<string>;
}

function entryOf(p: Pipeline): CollectionEntry {
  return (
    readEntry<CollectionEntry>(p.host, p.key) ?? { state: null, error: null, loadingMore: false }
  );
}

/** The scope's state holds `id`: a loaded item, or a member of its index. */
function holder(state: CollectionState): (id: string) => boolean {
  return (id) => state.revById.has(id) || state.byId.has(id);
}

/** Tells the overlay store what the scope's state `state` means for the items added to it. */
function tellAdditions(
  p: Pipeline,
  state: CollectionState,
  evidence: Omit<ScopeEvidence, "holds"> = {},
): void {
  settleAdditions(p.host.queryClient, p.target.service, p.target.collection, p.scope, {
    ...evidence,
    holds: holder(state),
  });
}

function write(p: Pipeline, change: Partial<CollectionEntry>): void {
  writeEntry(p.host, p.key, Object.freeze({ ...entryOf(p), ...change }));
  if (change.state !== undefined && change.state !== null) {
    tellAdditions(p, change.state);
  }
}

/** The ids the deltas of `batches` name. */
function namedIn(batches: readonly DeltaBatch[]): Set<string> {
  const named = new Set<string>();
  for (const batch of batches) {
    for (const delta of batch.deltas as readonly unknown[]) {
      const record = delta as { readonly id?: unknown; readonly item?: { readonly id?: unknown } };
      const id = record.id ?? record.item?.id;
      if (typeof id === "string") {
        named.add(id);
      }
    }
  }
  return named;
}

/**
 * Reports the revision of every item a delta names to the overlay store:
 * from a frame, or (with `readAt`, when the load was sent) from a resume
 * reply, which ends an optimistic layer only when it was asked for after the
 * call's reply.
 */
function observeDeltas(p: Pipeline, batch: DeltaBatch, readAt?: number): void {
  for (const delta of batch.deltas as readonly unknown[]) {
    const record = delta as { readonly id?: unknown; readonly item?: { readonly id?: unknown } };
    const id = record.id ?? record.item?.id;
    if (typeof id === "string") {
      p.host.overlays.observe(p.target.service, id, batch.rev, readAt);
    }
  }
}

function settle(p: Pipeline, error: QuickdrawError | null): void {
  const waiting = [...p.settled];
  p.settled.clear();
  for (const done of waiting) {
    done(error);
  }
}

/** Loads the ids patches found missing, at the next microtask, together. */
function loadMissing(p: Pipeline, ids: readonly string[]): void {
  const first = p.missing.size === 0;
  for (const id of ids) {
    p.missing.add(id);
  }
  if (first && p.missing.size > 0) {
    queueMicrotask(() => {
      const wanted = [...p.missing];
      p.missing.clear();
      loadItems(p, wanted).catch(() => undefined);
    });
  }
}

function scheduleReset(p: Pipeline): void {
  if (p.resetTimer !== undefined || p.disposed) {
    return;
  }
  const { min, max } = RESET_DELAY_MS;
  p.resetTimer = setTimeout(
    () => {
      p.resetTimer = undefined;
      load(p, "snapshot");
    },
    min + Math.random() * (max - min),
  );
}

/** What a load leaves to do once its answer is applied. */
function followUp(p: Pipeline, result: DeltaResult, reloaded: boolean): void {
  if (result.reset) {
    scheduleReset(p);
  }
  if (result.missing.length > 0) {
    loadMissing(p, result.missing);
  }
  if (reloaded && p.allDemand === 0) {
    // Items loaded before a snapshot and not on its page may have changed.
    loadMissing(p, staleIds(result.state));
  } else if (reloaded) {
    // The pages that follow bring back every member: those they do not are gone.
    p.pruneAfterPages = true;
  }
  void continueLoadAll(p);
}

/**
 * After `load: "all"` read pages following a snapshot: once the last page is
 * read, drops the items none of them refreshed; when nobody loads every page
 * any more before then, loads those items by id instead.
 */
function pruneUnseen(p: Pipeline): void {
  const state = entryOf(p).state;
  if (!p.pruneAfterPages || p.disposed || state === null) {
    return;
  }
  if (state.nextCursor === null) {
    p.pruneAfterPages = false;
    const pruned = pruneStale(state);
    if (pruned !== state) {
      write(p, { state: pruned });
    }
  } else if (p.allDemand === 0) {
    p.pruneAfterPages = false;
    loadMissing(p, staleIds(state));
  }
}

/** Applies the answer of a load sent at `readAt`, then the frames kept while it was in flight. */
function applyLoad(
  p: Pipeline,
  reply: Readonly<Record<string, unknown>>,
  kept: DeltaBatch[],
  readAt: number,
): void {
  const base = entryOf(p).state;
  const options = { loadAll: p.allDemand > 0 };
  let applied: DeltaResult;
  if (reply.resumed === true && isRevision(reply.rev) && Array.isArray(reply.deltas)) {
    const batch: DeltaBatch = { rev: reply.rev, deltas: reply.deltas as DeltaBatch["deltas"] };
    observeDeltas(p, batch, readAt);
    applied = applyDeltas(base, batch.deltas, batch.rev, p.shape, options);
  } else if (isPage(reply)) {
    observeItems(p, reply.items, reply.rev, readAt);
    applied = { state: applySnapshot(base, reply, p.shape), reset: false, missing: [] };
  } else {
    refused(p, malformed("qd:col:sub"));
    return;
  }
  for (const frame of kept) {
    observeDeltas(p, frame);
  }
  const after = applyFrames(applied.state, kept, p.shape, options);
  write(p, { state: after.state, error: null });
  // A load sent after an addition's reply would hold its row if it were a member.
  const resumed = reply.resumed === true && Array.isArray(reply.deltas);
  const deltas = resumed ? [{ rev: 0, deltas: reply.deltas as DeltaBatch["deltas"] }] : [];
  tellAdditions(p, after.state, { readAt, named: namedIn([...deltas, ...kept]) });
  p.joined = true;
  settle(p, null);
  const reloaded = reply.resumed !== true && base !== null;
  followUp(
    p,
    {
      state: after.state,
      reset: applied.reset || after.reset,
      missing: [...applied.missing, ...after.missing],
    },
    reloaded,
  );
}

/** A load was refused: access or the scope is gone (the state is dropped), or something else (it stays). */
function refused(p: Pipeline, error: QuickdrawError): void {
  p.joined = false;
  const drops = ["FORBIDDEN", "NOT_FOUND", "UNAUTHENTICATED"].includes(error.code);
  write(p, drops ? { state: null, error, loadingMore: false } : { error });
  settle(p, error);
}

/** What came back for a load. */
interface Loaded {
  readonly generation: number;
  readonly kind: LoadKind;
  /** The overlay store's clock when the load was sent. */
  readonly readAt: number;
}

function loaded(p: Pipeline, { generation, kind, readAt }: Loaded, outcome: Outcome): void {
  if (generation !== p.generation || p.disposed) {
    return;
  }
  p.loading = undefined;
  const kept = p.buffered;
  p.buffered = [];
  if (outcome.kind === "ok") {
    applyLoad(p, outcome.reply, kept, readAt);
  } else if (outcome.kind === "refused") {
    refused(p, outcome.error);
  } else if (outcome.kind === "retry") {
    p.retryTimer = setTimeout(() => {
      p.retryTimer = undefined;
      load(p, kind);
    }, outcome.delayMs);
  } else {
    // The socket is down: the next connect resumes the scope.
    p.joined = false;
  }
}

type LoadKind = "snapshot" | "resume";

/** Loads the scope: from the revision held (`resume`), or from scratch. */
function load(p: Pipeline, kind: LoadKind): void {
  clearTimeout(p.retryTimer);
  p.retryTimer = undefined;
  p.generation += 1;
  const { generation } = p;
  p.loading = generation;
  p.buffered = [];
  const state = kind === "resume" ? entryOf(p).state : null;
  const since = state !== null && state.rev > 0 ? state.rev : undefined;
  const limit = pageLimit(p);
  const frame = {
    s: p.target.service,
    c: p.target.collection,
    scope: p.scope,
    ...(since === undefined ? {} : { since }),
    ...(limit === undefined ? {} : { limit }),
  };
  const sent: Loaded = { generation, kind, readAt: p.host.overlays.now() };
  request(p.host, CLIENT_EVENTS.collectionSub, frame, (outcome) => {
    loaded(p, sent, outcome);
  });
}

/** The page size to ask for: the hook's, else the largest while every page is loaded, else the collection's. */
function pageLimit(p: Pipeline): number | undefined {
  if (p.limit !== undefined) {
    return p.limit;
  }
  return p.allDemand > 0 ? (p.target.def.maxLimit ?? DEFAULT_COLLECTION_MAX_LIMIT) : undefined;
}

/** Reads pages while some user wants every page, the scope is joined and no load is in flight. */
async function readPages(p: Pipeline): Promise<void> {
  while (p.allDemand > 0 && !p.disposed && p.joined && p.loading === undefined) {
    if ((entryOf(p).state?.nextCursor ?? null) === null || !(await loadPage(p))) {
      return;
    }
  }
}

/**
 * Reads every page for `load: "all"`. One reader at a time; asked again
 * while it reads (a load of the scope landed, which cancels the page in
 * flight), it reads again from the new cursor once it stops.
 */
async function continueLoadAll(p: Pipeline): Promise<void> {
  if (p.allLoop) {
    p.allAgain = true;
    return;
  }
  p.allLoop = true;
  try {
    do {
      p.allAgain = false;
      await readPages(p);
    } while (p.allAgain);
    pruneUnseen(p);
  } finally {
    p.allLoop = false;
  }
}

function resume(p: Pipeline, reason: ResumeReason): void {
  if (p.disposed) {
    return;
  }
  if (reason === "connect") {
    // The server forgot the socket's rooms with the old connection.
    p.joined = false;
  } else if (!p.joined || p.loading !== undefined) {
    return;
  }
  if (p.resetTimer !== undefined) {
    return;
  }
  const entry = entryOf(p);
  load(p, entry.state !== null && entry.error === null ? "resume" : "snapshot");
}

function receive(p: Pipeline, frame: CollectionFrame): void {
  if (p.disposed) {
    return;
  }
  const batch: DeltaBatch = { rev: frame.rev, deltas: frame.deltas };
  if (p.loading !== undefined) {
    p.buffered.push(batch);
    return;
  }
  const base = entryOf(p).state;
  if (base === null) {
    // Joined, but the cached state is gone (the cache was cleared): load it again.
    load(p, "snapshot");
    return;
  }
  observeDeltas(p, batch);
  const result = applyDeltas(base, batch.deltas, batch.rev, p.shape, { loadAll: p.allDemand > 0 });
  if (result.state !== base) {
    write(p, { state: result.state });
  }
  tellAdditions(p, result.state, { named: namedIn([batch]) });
  followUp(p, result, false);
}

function revoked(p: Pipeline, reason: RevokeReason): void {
  p.generation += 1;
  p.loading = undefined;
  p.buffered = [];
  clearTimeout(p.resetTimer);
  clearTimeout(p.retryTimer);
  p.resetTimer = undefined;
  p.retryTimer = undefined;
  p.joined = false;
  const error =
    reason === "anchor-deleted"
      ? new QuickdrawError("NOT_FOUND", "The row this scope belongs to was deleted")
      : new QuickdrawError("FORBIDDEN", "Access to the scope was revoked");
  write(p, { state: null, error, loadingMore: false });
  settle(p, error);
}

/** Resolves once the scope is joined; rejects with the error its next load is refused with. */
function whenJoined(p: Pipeline): Promise<void> {
  if (p.joined) {
    return Promise.resolve();
  }
  return new Promise((resolve, reject) => {
    p.settled.add((error) => {
      if (error === null) {
        resolve();
      } else {
        reject(error);
      }
    });
  });
}

/** Stops the reload a `reset` scheduled, a load's retry, and the waits of pages and items. */
function stopTimers(p: Pipeline): void {
  clearTimeout(p.resetTimer);
  clearTimeout(p.retryTimer);
  p.resetTimer = undefined;
  p.retryTimer = undefined;
  endWaits(p);
}

function dispose(p: Pipeline): void {
  p.disposed = true;
  p.generation += 1;
  stopTimers(p);
  settle(p, null);
  const { socket } = p.host.connection;
  if (socket.connected) {
    socket.emit(CLIENT_EVENTS.collectionUnsub, {
      s: p.target.service,
      c: p.target.collection,
      scope: p.scope,
    });
  }
}

/** The state of a new scope's pipeline, before its first load. */
function createPipeline(
  host: LiveHost,
  target: CollectionTarget,
  scope: string,
  limit: number | undefined,
): Pipeline {
  const p: Pipeline = {
    host,
    target,
    scope,
    key: collectionKey(target.service, target.collection, scope),
    shape: { index: target.def.index, order: target.def.order },
    limit,
    generation: 0,
    loading: undefined,
    buffered: [],
    resetTimer: undefined,
    retryTimer: undefined,
    joined: false,
    settled: new Set(),
    allDemand: 0,
    allLoop: false,
    allAgain: false,
    pruneAfterPages: false,
    missing: new Set(),
    disposed: false,
    page: undefined,
    waits: new Map(),
    pageLimit: () => pageLimit(p),
    currentState: () => entryOf(p).state,
    write: (change) => {
      write(p, change);
    },
    whenJoined: () => whenJoined(p),
  };
  return p;
}

/** Keeps items read outside the scope at `rev` in its loaded state (`CollectionController.keep`). */
function keep(p: Pipeline, items: readonly unknown[], rev: Revision): boolean {
  const state = entryOf(p).state;
  if (p.disposed || state === null) {
    return false;
  }
  const kept = applyKept(state, items, rev, p.shape, { loadAll: p.allDemand > 0 });
  if (kept.state !== state) {
    write(p, { state: kept.state });
  }
  if (kept.missing.length > 0) {
    loadMissing(p, kept.missing);
  }
  return true;
}

/** Loads every page of the scope while the returned release is not called. */
function holdLoadAll(p: Pipeline): () => void {
  p.allDemand += 1;
  void continueLoadAll(p);
  let released = false;
  return () => {
    if (!released) {
      released = true;
      p.allDemand -= 1;
    }
  };
}

/** Creates the pipeline of one scope; `start` loads it. `limit` is the page size asked for. */
export function createCollectionController(
  host: LiveHost,
  target: CollectionTarget,
  scope: string,
  limit: number | undefined,
): CollectionController {
  const p = createPipeline(host, target, scope, limit);
  return Object.freeze({
    key: p.key,
    scope,
    start: () => {
      load(p, "snapshot");
    },
    receive: (frame: CollectionFrame) => {
      receive(p, frame);
    },
    revoked: (reason: RevokeReason) => {
      revoked(p, reason);
    },
    resume: (reason: ResumeReason) => {
      resume(p, reason);
    },
    refresh: () =>
      new Promise<void>((resolve) => {
        p.settled.add(() => {
          resolve();
        });
        load(p, "snapshot");
      }),
    loadMore: async () => {
      await loadPage(p);
    },
    loadItems: (ids: readonly string[]) => loadItems(p, ids),
    loadAll: () => holdLoadAll(p),
    keep: (items: readonly unknown[], rev: Revision) => keep(p, items, rev),
    forget: () => {
      write(p, { state: null, error: null, loadingMore: false });
      load(p, "snapshot");
    },
    stop: () => {
      p.joined = false;
      stopTimers(p);
    },
    dispose: () => {
      dispose(p);
    },
  });
}
