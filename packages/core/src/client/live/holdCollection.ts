// `holdCollection(store, target, listener)` (RFC 0003 sections 7 and 11.5):
// one scope of a contract's collection, held in a script's live store
// (`liveStore.ts`) and shown as `useCollection` shows it (`views.ts`), with
// no optimistic overlays: its members (the index, filtered by `view` for
// the connection's user) and the items loaded, kept current by deltas and
// resumed by revision after a reconnect. See `holding.ts` for when the
// listener is called.
//
// React-free, and TanStack-free.

import type { AnyContract } from "../../contract/defineContract";
import type { CollectionName, IndexRowOf, ItemOf, ScopeOf, ViewName } from "../../contract/infer";
import { awaitingHelloOf, userOf } from "../cacheSession";
import { collectionKey } from "../keys";
import type { CollectionEntry, CollectionTarget } from "./collectionLoads";
import { holdingOf, type CollectionHolding, type CollectionSnapshot } from "./holding";
import { liveCacheOf, type LiveStore } from "./liveStore";
import { showCollection, viewPredicate, type CollectionView } from "./views";

/** What `holdCollection` holds: one scope of a contract's collection. */
export interface HoldCollectionTarget<C extends AnyContract, K extends CollectionName<C>> {
  readonly contract: C;
  readonly collection: K;
  /** The scope: a non-empty string. */
  readonly scope: ScopeOf<C, K>;
  /** A view the collection declares: only the members it selects for the connection's user show. */
  readonly view?: ViewName<C, K>;
  /** `"all"` loads every page of the scope, and keeps every item loaded as it changes. */
  readonly load?: "all";
  /**
   * The page size to ask for; above the collection's `maxLimit` it is
   * lowered (`clamped`). The first holder of a scope sets it. Default: the
   * collection's `limit`, or its `maxLimit` with `load: "all"`.
   */
  readonly limit?: number;
}

const NOTHING: CollectionView<never> = Object.freeze({
  items: Object.freeze([]),
  index: undefined,
  byId: new Map<string, never>(),
});

function snapshotOf(
  entry: CollectionEntry | undefined,
  view: CollectionView<{ readonly id: string }>,
): CollectionSnapshot<unknown, unknown> {
  const state = entry?.state ?? null;
  const error = entry?.error ?? null;
  return Object.freeze({
    items: view.items,
    index: view.index,
    byId: view.byId,
    totalCount: state?.totalCount ?? null,
    hasMore: (state?.nextCursor ?? null) !== null,
    clamped: state?.clamped ?? false,
    indexTruncated: state?.indexTruncated ?? false,
    isLoading: state === null && error === null,
    isLoadingMore: entry?.loadingMore ?? false,
    error,
  });
}

/**
 * Holds scope `target.scope` of `target.collection` in `store`, and calls
 * `listener` with what it shows as that changes. Throws a `TypeError` for a
 * collection the contract does not declare, or a scope that is not a
 * non-empty string.
 *
 * @example
 * const cards = holdCollection(live, { contract: task, collection: "byProject", scope: projectId }, (scope) => {
 *   if (scope.items.some((card) => card.status === "open")) cards.release();
 * });
 */
export function holdCollection<C extends AnyContract, K extends CollectionName<C>>(
  store: LiveStore,
  target: HoldCollectionTarget<C, K>,
  listener: (snapshot: CollectionSnapshot<ItemOf<C, K>, IndexRowOf<C, K>>) => void,
): CollectionHolding<ItemOf<C, K>, IndexRowOf<C, K>> {
  const { contract, collection } = target;
  const scope: unknown = target.scope;
  const def = Object.hasOwn(contract.collections, collection)
    ? contract.collections[collection]
    : undefined;
  if (def === undefined) {
    throw new TypeError(`holdCollection: ${contract.name} declares no collection ${collection}`);
  }
  if (typeof scope !== "string" || scope === "") {
    throw new TypeError("holdCollection: scope must be a non-empty string");
  }
  const cache = liveCacheOf(store);
  const { connection } = store;
  const key = collectionKey(contract.name, collection, scope);
  const predicate = viewPredicate(def, target.view);
  let last:
    | {
        readonly entry: CollectionEntry | undefined;
        readonly userId: string | null;
        readonly snapshot: CollectionSnapshot<unknown, unknown>;
      }
    | undefined;
  const read = (): CollectionSnapshot<unknown, unknown> => {
    // Awaiting new credentials' hello, it shows nothing of what is cached.
    const entry = awaitingHelloOf(connection, cache)
      ? undefined
      : (cache.get(key) as CollectionEntry | undefined);
    const userId = predicate === undefined ? null : userOf(connection.getState().hello);
    if (last !== undefined && last.entry === entry && last.userId === userId) {
      return last.snapshot;
    }
    const state = entry?.state ?? null;
    const view =
      state === null
        ? NOTHING
        : showCollection(state, {
            view: predicate,
            who: { userId: userId ?? "" },
            overlay: (row) => row,
          });
    const snapshot = snapshotOf(entry, view);
    last = { entry, userId, snapshot };
    return snapshot;
  };
  const live: CollectionTarget = { service: contract.name, collection, def };
  const holding = store.collections.subscribe(live, scope, {
    limit: target.limit,
    loadAll: target.load === "all",
  });
  let released = false;
  const base = holdingOf(
    read,
    (changed) => {
      const stopEntry = cache.listen(key, changed);
      const stopHellos = connection.subscribe(changed);
      return () => {
        stopEntry();
        stopHellos();
      };
    },
    () => {
      released = true;
      holding.release();
    },
    listener as (snapshot: CollectionSnapshot<unknown, unknown>) => void,
  );
  const { controller } = holding;
  return Object.freeze({
    current: base.current as () => CollectionSnapshot<ItemOf<C, K>, IndexRowOf<C, K>>,
    release: base.release,
    // Released, they do nothing, as a hook's do once unmounted.
    loadMore: async (): Promise<void> => {
      if (!released) {
        await controller.loadMore();
      }
    },
    loadItems: async (ids: readonly string[]): Promise<void> => {
      if (!released) {
        await controller.loadItems(ids);
      }
    },
    refresh: async (): Promise<void> => {
      if (!released) {
        await controller.refresh();
      }
    },
  });
}
