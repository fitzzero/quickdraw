// The invalidation coordinator (RFC 0003 section 11.3): one per `QueryClient`,
// shared by every hook, `qd.invalidate`, the watched topics and non-React
// code, so a query key has at most one read in flight and at most one queued
// behind it however many invalidations arrive.
//
// 4.1 debounced each hook instance for 100 ms and then called
// `invalidateQueries`, whose default cancels the read in flight and starts
// another while the server keeps computing the abandoned one
// (`legacy-src/client/useServiceQuery.ts:141-166`); a reconnect invalidated
// every query at once (`legacy-src/client/QuickdrawProvider.tsx:320-321`).
// Passing `cancelRefetch: false` alone is not enough: the read in flight is
// kept, but the invalidation is lost, because a successful fetch clears
// TanStack's `isInvalidated` flag. Here, per cached query:
//
// - idle and outside a window: refetch now (never cancelling), then open a
//   window (250 ms by default);
// - inside the window: remember it (`pending`); when the window ends,
//   refetch if the query is idle, or else mark it dirty;
// - while a read is in flight: mark it dirty. When the read settles (data
//   or error) and the query still has observers, refetch exactly once;
// - a query without observers is only marked stale: nothing reads it, and
//   its next observer refetches it. One being read without observers (a
//   prefetch) is marked stale when that read settles, since the read's
//   success clears the mark.
//
// The coordinator watches the `QueryCache` only while it has keys to look
// after, drops a key when its last observer leaves or the query leaves the
// cache, and coordinates at most `maxKeys` keys at once; past that a key is
// refetched without a window or a follow-up, still without cancelling.
//
// React-free: the provider makes one per `QueryClient` and retains it while
// mounted, so its windows and delayed refetches stop a tick after it
// unmounts; a client without React makes its own with
// `createInvalidationCoordinator(queryClient)` and disposes it.

import type { Query, QueryCacheNotifyEvent, QueryClient, QueryKey } from "@tanstack/react-query";
import { KEY_ROOT } from "./keys";

/** How long after a refetch further invalidations of the key are served together, by default. */
export const DEFAULT_INVALIDATION_WINDOW_MS = 250;

/** How many keys a coordinator looks after at once, by default. */
export const DEFAULT_MAX_COORDINATED_KEYS = 1000;

/** The longest random delay of a refetch after a reconnect, by default. */
export const RECONNECT_JITTER_MS = 2000;

/** Options of {@link InvalidationCoordinator.invalidate}. */
export interface InvalidateOptions {
  /** Match `queryKey` exactly, rather than as a prefix, which is TanStack's default. */
  readonly exact?: boolean;
  /**
   * How long after a refetch this key's further invalidations are served
   * together, as one refetch when the window ends. Default: the coordinator's.
   */
  readonly windowMs?: number;
}

/** Options of {@link createInvalidationCoordinator}. */
export interface CoordinatorOptions {
  /** The default window of `invalidate`. Default 250 ms. */
  readonly windowMs?: number;
  /** How many keys are coordinated at once; others are refetched without a window. Default 1,000. */
  readonly maxKeys?: number;
}

/** Options of {@link InvalidationCoordinator.refetchAfterReconnect}. */
export interface ReconnectRefetchOptions {
  /**
   * True for a query that watches a change topic: it missed every
   * `qd:changed` while the connection was down, so it is refetched even when
   * it is fresh.
   */
  readonly watched: (query: Query) => boolean;
  /** The longest random delay before each refetch. Default 2,000 ms. */
  readonly jitterMs?: number;
  /** Which queries to consider: those this key prefixes. Default `["qd"]`, every quickdraw query. */
  readonly queryKey?: QueryKey;
}

/** The invalidation coordinator of one `QueryClient`. */
export interface InvalidationCoordinator {
  readonly queryClient: QueryClient;
  /**
   * Invalidates the cached queries `queryKey` matches (a prefix, unless
   * `exact`): each is refetched without cancelling a read in flight, at most
   * one read in flight and one queued behind it. Returns at once; the
   * refetches run in the background.
   */
  invalidate(queryKey: QueryKey, options?: InvalidateOptions): void;
  /**
   * After a reconnect: refetches the active queries that are watched or
   * stale, each after its own random delay of up to `jitterMs`, unless by
   * then it is reading, or it has been read since the reconnect.
   */
  refetchAfterReconnect(options: ReconnectRefetchOptions): void;
  /**
   * Holds the coordinator for one user of it (a mounted provider) and
   * returns the release. A tick after the last release it is disposed,
   * unless it is retained again first, as React's strict mode does when it
   * mounts effects twice; retaining a disposed coordinator takes it up again.
   */
  retain(): () => void;
  /** Stops every window and pending refetch, and lets a new coordinator be made for the client. */
  dispose(): void;
}

type Timer = ReturnType<typeof setTimeout>;

/** What the coordinator looks after for one cached query. */
interface Entry {
  readonly query: Query;
  /** The window the next refetch opens. */
  windowMs: number;
  /** Open after a refetch; invalidations meanwhile wait for its end. */
  window: Timer | undefined;
  /** An invalidation arrived during the window. */
  pending: boolean;
  /** An invalidation arrived during a read: refetch once when it settles. */
  dirty: boolean;
}

interface State {
  readonly queryClient: QueryClient;
  readonly windowMs: number;
  readonly maxKeys: number;
  /** By query hash. */
  readonly entries: Map<string, Entry>;
  /** The delayed refetches of `refetchAfterReconnect`. */
  readonly delayed: Set<Timer>;
  /** Stops watching the cache; set while there are entries. */
  unsubscribe: (() => void) | undefined;
  disposed: boolean;
  /** How many users retain the coordinator, and the disposal a tick after the last let go. */
  users: number;
  disposeTimer: Timer | undefined;
}

const coordinators = new WeakMap<QueryClient, InvalidationCoordinator>();

function isReading(query: Query): boolean {
  return query.state.fetchStatus !== "idle";
}

/** Refetches `query` if it is active, keeping a read in flight. */
function refetchNow(state: State, query: Query): void {
  void state.queryClient.invalidateQueries(
    { queryKey: query.queryKey, exact: true },
    { cancelRefetch: false },
  );
}

/** Marks `query` stale without reading it: its next observer refetches it. */
function markStale(state: State, query: Query): void {
  void state.queryClient.invalidateQueries({
    queryKey: query.queryKey,
    exact: true,
    refetchType: "none",
  });
}

/** Stops looking after a query, and stops watching the cache when it was the last. */
function drop(state: State, entry: Entry): void {
  clearTimeout(entry.window);
  if (state.entries.get(entry.query.queryHash) === entry) {
    state.entries.delete(entry.query.queryHash);
  }
  if (state.entries.size === 0) {
    state.unsubscribe?.();
    state.unsubscribe = undefined;
  }
}

/** Stops looking after a query nothing observes; an invalidation it was owed leaves it stale. */
function abandon(state: State, entry: Entry): void {
  drop(state, entry);
  if (entry.pending || entry.dirty) {
    markStale(state, entry.query);
  }
}

/** Refetches now and opens the window. */
function fire(state: State, entry: Entry): void {
  entry.pending = false;
  refetchNow(state, entry.query);
  entry.window = setTimeout(() => {
    windowEnded(state, entry);
  }, entry.windowMs);
}

/** Serves an invalidation owed outside a window: refetch, or wait for the read in flight. */
function serve(state: State, entry: Entry): void {
  if (entry.query.getObserversCount() === 0) {
    entry.pending = true;
    abandon(state, entry);
  } else if (isReading(entry.query)) {
    entry.dirty = true;
  } else {
    fire(state, entry);
  }
}

function windowEnded(state: State, entry: Entry): void {
  entry.window = undefined;
  if (entry.pending) {
    entry.pending = false;
    serve(state, entry);
  } else if (!entry.dirty) {
    drop(state, entry);
  }
}

/** A read of a dirty query settled, it lost its last observer, or it left the cache. */
function onCacheEvent(state: State, event: QueryCacheNotifyEvent): void {
  const entry = state.entries.get(event.query.queryHash);
  if (entry === undefined || entry.query !== event.query) {
    return;
  }
  if (event.type === "removed") {
    drop(state, entry);
  } else if (event.type === "observerRemoved" && event.query.getObserversCount() === 0) {
    abandon(state, entry);
  } else if (event.type === "updated" && entry.dirty && !isReading(entry.query)) {
    entry.dirty = false;
    if (entry.window === undefined) {
      serve(state, entry);
    } else {
      entry.pending = true;
    }
  }
}

/** The entry of `query`, made when there is room; watches the cache while there are entries. */
function entryFor(state: State, query: Query): Entry | undefined {
  const existing = state.entries.get(query.queryHash);
  if (existing?.query === query) {
    return existing;
  }
  if (existing !== undefined) {
    drop(state, existing);
  }
  if (state.entries.size >= state.maxKeys) {
    return undefined;
  }
  const entry: Entry = {
    query,
    windowMs: state.windowMs,
    window: undefined,
    pending: false,
    dirty: false,
  };
  state.entries.set(query.queryHash, entry);
  state.unsubscribe ??= state.queryClient.getQueryCache().subscribe((event) => {
    onCacheEvent(state, event);
  });
  return entry;
}

/** One invalidation of one cached query. */
function request(state: State, query: Query, windowMs: number): void {
  const observed = query.getObserversCount() > 0;
  if (!observed && !isReading(query)) {
    markStale(state, query);
    return;
  }
  const entry = state.disposed ? undefined : entryFor(state, query);
  if (entry === undefined) {
    if (observed) {
      refetchNow(state, query);
    } else {
      markStale(state, query);
    }
    return;
  }
  entry.windowMs = windowMs;
  if (!observed) {
    // A read nobody observes (a prefetch): marked stale once it settles,
    // since its success would clear the mark set now.
    entry.dirty = true;
  } else if (entry.window === undefined) {
    serve(state, entry);
  } else {
    entry.pending = true;
  }
}

/** A delayed refetch after a reconnect, unless the query was read since or no longer needs it. */
function refreshAfter(state: State, query: Query, since: number): void {
  const cached = state.queryClient.getQueryCache().get(query.queryHash) === query;
  const { dataUpdatedAt, errorUpdatedAt } = query.state;
  // Strictly later: a read that landed in the reconnect's millisecond may have been sent before it.
  const readSince = Math.max(dataUpdatedAt, errorUpdatedAt) > since;
  if (cached && query.isActive() && !isReading(query) && !readSince) {
    request(state, query, state.windowMs);
  }
}

function refetchAfterReconnect(state: State, options: ReconnectRefetchOptions): void {
  const since = Date.now();
  const jitterMs = options.jitterMs ?? RECONNECT_JITTER_MS;
  const queries = state.queryClient
    .getQueryCache()
    .findAll({ queryKey: options.queryKey ?? [KEY_ROOT] });
  for (const query of queries) {
    if (query.isActive() && (options.watched(query) || query.isStale())) {
      const timer = setTimeout(() => {
        state.delayed.delete(timer);
        refreshAfter(state, query, since);
      }, Math.random() * jitterMs);
      state.delayed.add(timer);
    }
  }
}

function retain(state: State, coordinator: InvalidationCoordinator): () => void {
  state.users += 1;
  clearTimeout(state.disposeTimer);
  state.disposeTimer = undefined;
  if (state.disposed) {
    state.disposed = false;
    if (!coordinators.has(state.queryClient)) {
      coordinators.set(state.queryClient, coordinator);
    }
  }
  let released = false;
  return () => {
    if (released) {
      return;
    }
    released = true;
    state.users -= 1;
    if (state.users === 0) {
      state.disposeTimer = setTimeout(() => {
        state.disposeTimer = undefined;
        dispose(state, coordinator);
      }, 0);
    }
  };
}

function dispose(state: State, coordinator: InvalidationCoordinator): void {
  clearTimeout(state.disposeTimer);
  state.disposeTimer = undefined;
  state.disposed = true;
  for (const entry of [...state.entries.values()]) {
    clearTimeout(entry.window);
  }
  state.entries.clear();
  for (const timer of state.delayed) {
    clearTimeout(timer);
  }
  state.delayed.clear();
  state.unsubscribe?.();
  state.unsubscribe = undefined;
  if (coordinators.get(state.queryClient) === coordinator) {
    coordinators.delete(state.queryClient);
  }
}

function checkCount(name: string, value: number | undefined, fallback: number): number {
  const count = value ?? fallback;
  if (typeof count !== "number" || !Number.isFinite(count) || count < 0) {
    throw new TypeError(`createInvalidationCoordinator: ${name} must be a number, 0 or more`);
  }
  return count;
}

/**
 * The invalidation coordinator of `queryClient`: made on the first call for
 * a client and returned again by later ones (whose options are then
 * ignored), so the provider, the hooks and non-React code share one per
 * client until it is disposed.
 *
 * @example
 * const coordinator = createInvalidationCoordinator(queryClient);
 * connection.watch({ service, topic, onChanged: () => coordinator.invalidate(key) });
 */
export function createInvalidationCoordinator(
  queryClient: QueryClient,
  options: CoordinatorOptions = {},
): InvalidationCoordinator {
  const existing = coordinators.get(queryClient);
  if (existing !== undefined) {
    return existing;
  }
  const state: State = {
    queryClient,
    windowMs: checkCount("windowMs", options.windowMs, DEFAULT_INVALIDATION_WINDOW_MS),
    maxKeys: checkCount("maxKeys", options.maxKeys, DEFAULT_MAX_COORDINATED_KEYS),
    entries: new Map(),
    delayed: new Set(),
    unsubscribe: undefined,
    disposed: false,
    users: 0,
    disposeTimer: undefined,
  };
  const coordinator: InvalidationCoordinator = Object.freeze({
    queryClient,
    invalidate(queryKey: QueryKey, invalidateOptions: InvalidateOptions = {}): void {
      const windowMs = checkCount("windowMs", invalidateOptions.windowMs, state.windowMs);
      const filters = { queryKey, exact: invalidateOptions.exact === true };
      for (const query of queryClient.getQueryCache().findAll(filters)) {
        request(state, query, windowMs);
      }
    },
    refetchAfterReconnect(reconnect: ReconnectRefetchOptions): void {
      refetchAfterReconnect(state, reconnect);
    },
    retain: () => retain(state, coordinator),
    dispose(): void {
      dispose(state, coordinator);
    },
  });
  coordinators.set(queryClient, coordinator);
  return coordinator;
}
