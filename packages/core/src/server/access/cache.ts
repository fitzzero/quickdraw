// Memoized and cached policy lookups (RFC 0003 section 4.2): "results are
// memoized per request; an optional `cacheMs` keeps them across requests;
// tracked writes to the membership model, the access column or the owner
// column evict the affected entries".
//
// Values are kept per namespace (one per service's rows, one per membership
// table a service's policy reads, one per service's levels), per scope (the
// user id for per-user values, `""` for a row's columns) and per row id.
//
// - The request memo holds promises, so two lookups of one row in a request,
//   even concurrent ones, share one query. It lives for one engine call: an
//   authorization, or one `levelsFor` / `accessWhere` of the dispatcher.
// - The cross-request cache holds settled values until `cacheMs` passes or a
//   tracked write evicts them (`changes.ts`). Only the database reads are
//   kept (row columns and membership levels), never a level computed from
//   them, so a change to a parent row needs no cascade: the child's level is
//   recomputed from the parent's freshly read values.
// - A lookup is kept across requests only when no eviction of its namespace
//   happened while it ran (the namespace's generation is unchanged), and
//   only when it did not read inside a transaction, whose uncommitted rows
//   may yet roll back. A deny is kept like a grant, under the same eviction.

/** A namespace of cached values; compared by identity. */
export interface Namespace {
  /** For debugging: what the namespace holds. */
  readonly label: string;
}

/** Creates a namespace. */
export function namespace(label: string): Namespace {
  return Object.freeze({ label });
}

type Scoped<V> = Map<string, Map<string, V>>;

function getIn<V>(
  store: Map<Namespace, Scoped<V>>,
  ns: Namespace,
  scope: string,
  id: string,
): V | undefined {
  return store.get(ns)?.get(scope)?.get(id);
}

function setIn<V>(
  store: Map<Namespace, Scoped<V>>,
  ns: Namespace,
  scope: string,
  id: string,
  value: V,
): boolean {
  let scopes = store.get(ns);
  if (scopes === undefined) {
    scopes = new Map();
    store.set(ns, scopes);
  }
  let ids = scopes.get(scope);
  if (ids === undefined) {
    ids = new Map();
    scopes.set(scope, ids);
  }
  const added = !ids.has(id);
  ids.set(id, value);
  return added;
}

/** One engine call's memo: lookups in flight or settled, by namespace, scope and id. */
export interface RequestMemo {
  get(ns: Namespace, scope: string, id: string): Promise<unknown> | undefined;
  set(ns: Namespace, scope: string, id: string, value: Promise<unknown>): void;
}

/** Creates the memo of one engine call. */
export function createRequestMemo(): RequestMemo {
  const store = new Map<Namespace, Scoped<Promise<unknown>>>();
  return {
    get: (ns, scope, id) => getIn(store, ns, scope, id),
    set(ns, scope, id, value) {
      setIn(store, ns, scope, id, value);
    },
  };
}

interface Entry {
  readonly value: unknown;
  readonly expiresAt: number;
}

/** Options of {@link createAccessCache}. */
export interface AccessCacheOptions {
  /** How long a value is kept, in milliseconds. */
  readonly ttlMs: number;
  /** At most this many values are kept; past it, expired ones are dropped, then all. Default 100,000. */
  readonly maxEntries?: number;
  /** The clock. Default `Date.now`. */
  readonly now?: () => number;
}

/** The cross-request cache of policy lookups. */
export interface AccessCache {
  /** The value kept for the row, or `undefined` when none is (a kept value may be `null`). */
  get(ns: Namespace, scope: string, id: string): { readonly value: unknown } | undefined;
  set(ns: Namespace, scope: string, id: string, value: unknown): void;
  /**
   * Drops kept values: one (`scope` and `id`), the row's in every scope
   * (`id` only), or the whole namespace (neither). Every eviction moves the
   * namespace to its next generation.
   */
  evict(ns: Namespace, scope?: string, id?: string): void;
  /** Changes on every eviction in `ns`; a lookup that saw it change while running is not kept. */
  generation(ns: Namespace): number;
  /** How many values are kept. */
  readonly size: number;
}

const DEFAULT_MAX_ENTRIES = 100_000;

/** Creates the cross-request cache. */
export function createAccessCache(options: AccessCacheOptions): AccessCache {
  const { ttlMs } = options;
  const maxEntries = options.maxEntries ?? DEFAULT_MAX_ENTRIES;
  const now = options.now ?? Date.now;
  const store = new Map<Namespace, Scoped<Entry>>();
  const generations = new Map<Namespace, number>();
  let size = 0;

  const bump = (ns: Namespace): void => {
    generations.set(ns, (generations.get(ns) ?? 0) + 1);
  };
  const sweep = (): void => {
    const time = now();
    for (const scopes of store.values()) {
      for (const ids of scopes.values()) {
        for (const [id, entry] of ids) {
          if (entry.expiresAt <= time) {
            ids.delete(id);
            size -= 1;
          }
        }
      }
    }
  };
  const evictRow = (scopes: Scoped<Entry>, scope: string | undefined, id: string): void => {
    const targets = scope === undefined ? [...scopes.values()] : [scopes.get(scope)];
    for (const ids of targets) {
      if (ids?.delete(id) === true) {
        size -= 1;
      }
    }
  };

  return {
    get(ns, scope, id) {
      const entry = getIn(store, ns, scope, id);
      if (entry === undefined) {
        return undefined;
      }
      if (entry.expiresAt <= now()) {
        store.get(ns)?.get(scope)?.delete(id);
        size -= 1;
        return undefined;
      }
      return { value: entry.value };
    },
    set(ns, scope, id, value) {
      if (size >= maxEntries) {
        sweep();
      }
      if (size >= maxEntries) {
        store.clear();
        size = 0;
      }
      if (setIn(store, ns, scope, id, { value, expiresAt: now() + ttlMs })) {
        size += 1;
      }
    },
    evict(ns, scope, id) {
      bump(ns);
      const scopes = store.get(ns);
      if (scopes === undefined) {
        return;
      }
      if (id !== undefined) {
        evictRow(scopes, scope, id);
        return;
      }
      for (const ids of scopes.values()) {
        size -= ids.size;
      }
      store.delete(ns);
    },
    generation: (ns) => generations.get(ns) ?? 0,
    get size() {
      return size;
    },
  };
}

/** Where a lookup reads through: the call's memo, and the cache when one is on. */
export interface LookupScope {
  readonly memo: RequestMemo;
  readonly cache: AccessCache | undefined;
  /** Whether a lookup starting now may be kept across requests (it is not inside a transaction). */
  keepable(): boolean;
}

/**
 * The values of `ids` in `ns` and `scope`: from the memo, then the cache, and
 * the rest from one call of `load`. An id `load` does not return is `null`.
 * Rejects when `load` does; the memo then holds the failure for the rest of
 * the call, and nothing is cached.
 */
export async function lookup<V>(
  where: LookupScope,
  ns: Namespace,
  scope: string,
  ids: readonly string[],
  load: (missing: readonly string[]) => Promise<ReadonlyMap<string, V>>,
): Promise<Map<string, V | null>> {
  const pending = new Map<string, Promise<V | null>>();
  const missing: string[] = [];
  for (const id of new Set(ids)) {
    const memoized = where.memo.get(ns, scope, id) as Promise<V | null> | undefined;
    const cached = memoized === undefined ? where.cache?.get(ns, scope, id) : undefined;
    if (memoized !== undefined) {
      pending.set(id, memoized);
    } else if (cached === undefined) {
      missing.push(id);
    } else {
      const value = Promise.resolve(cached.value as V | null);
      where.memo.set(ns, scope, id, value);
      pending.set(id, value);
    }
  }
  if (missing.length > 0) {
    const keepIn = where.cache !== undefined && where.keepable() ? where.cache : undefined;
    const generation = keepIn?.generation(ns);
    const batch = load(missing).then((loaded) => {
      if (keepIn !== undefined && keepIn.generation(ns) === generation) {
        for (const id of missing) {
          keepIn.set(ns, scope, id, loaded.get(id) ?? null);
        }
      }
      return loaded;
    });
    for (const id of missing) {
      const value = batch.then((loaded) => loaded.get(id) ?? null);
      where.memo.set(ns, scope, id, value);
      pending.set(id, value);
    }
  }
  const settled = await Promise.all(
    [...pending].map(async ([id, value]) => [id, await value] as const),
  );
  return new Map(settled);
}
