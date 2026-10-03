"use client";

// `qd.<service>.<collection>.useCollection(scope, options)` (RFC 0003
// sections 7, 11 and 11.5): one scope of a collection, live. Replaces 4.1's
// `useCollection(serviceName, collection, scopeId)`
// (`legacy-src/client/useCollection.ts:65-369`).
//
// Every component showing a scope shares its pipeline
// (`collectionController.ts`): one load, one page in flight, deltas applied
// by revision, a resume from the revision held after a reconnect, when the
// tab shows again after 30 s, and every 5 minutes. The hook shows the state
// cached under `["qd", service, "c", collection, scope]`:
//
// - `index`: the scope's members in order, one small row each (`id` and the
//   index fields), for a collection that declares `index`; with `view`, the
//   members the contract's view selects for the connection's user;
// - `items`: the items loaded among those members, in order. The first page
//   loads with the scope, `loadMore` loads the next, `loadItems(ids)` loads
//   chosen members, and `load: "all"` loads every page;
// - both with the overlays of optimistic mutations laid over them.

import { useQuery } from "@tanstack/react-query";
import { useEffect, useMemo, useRef } from "react";
import type { QuickdrawError } from "../../protocol/errors";
import { collectionKey } from "../keys";
import type { CollectionController } from "./collectionController";
import type { IndexRow } from "./collectionIndex";
import type { CollectionEntry, CollectionTarget } from "./collectionLoads";
import { entryQuery } from "./host";
import { useLiveData, useOverlayView, useUserId } from "./liveHooks";
import { showCollection, viewPredicate, type CollectionView } from "./views";

/** Options of `useCollection`. */
export interface UseCollectionOptions<View extends string = string> {
  /** A view the collection's contract declares: only the members it selects for the connection's user are shown. */
  readonly view?: View;
  /** `"all"` loads every page of the scope, and keeps every item loaded as it changes. */
  readonly load?: "all";
  /**
   * The page size to ask for; above the collection's `maxLimit` it is
   * lowered (`clamped`). The first component to show a scope sets it.
   * Default: the collection's `limit`, or its `maxLimit` with `load: "all"`.
   */
  readonly limit?: number;
  /**
   * `false` holds no subscription and shows nothing: no items, no index, no
   * count (and `isLoading` false), even while the scope is cached. Default
   * `true`.
   */
  readonly enabled?: boolean;
}

/** What `useCollection` returns. */
export interface UseCollectionResult<Item, Row> {
  /** The items loaded among the members shown, in order. */
  readonly items: readonly Item[];
  /**
   * The members shown, in order: one row each, `id` and the index fields.
   * `undefined` for a collection without an index, and for a scope too large
   * for one (`indexTruncated`), whose view then runs over the items loaded.
   */
  readonly index: readonly Row[] | undefined;
  /** `items` by id. */
  readonly byId: ReadonlyMap<string, Item>;
  /** How many members the scope has, whatever the view; `null` before the first load. */
  readonly totalCount: number | null;
  /** True while a page follows the items loaded (`loadMore`). */
  readonly hasMore: boolean;
  /** True when the page size asked for was above the collection's `maxLimit`, and was lowered to it. */
  readonly clamped: boolean;
  /** True when the scope has more members than an index holds (50,000), so `index` is `undefined`. */
  readonly indexTruncated: boolean;
  /** True until the scope's first load answers. */
  readonly isLoading: boolean;
  /** True while a page is being loaded. */
  readonly isLoadingMore: boolean;
  /** Why the last request failed, or why the server ended the subscription (`FORBIDDEN`, `NOT_FOUND`). */
  readonly error: QuickdrawError | null;
  /** Loads the next page; a load of the whole scope that starts meanwhile cancels it. */
  loadMore(): Promise<void>;
  /** Loads the items of members `ids` (at most 200 per request). Rejects with the server's refusal. */
  loadItems(ids: readonly string[]): Promise<void>;
  /** Loads the scope again from scratch. */
  refresh(): Promise<void>;
}

const NOTHING: CollectionView<never> = Object.freeze({
  items: [],
  index: undefined,
  byId: new Map<string, never>(),
});

/** What the hook returns besides what it shows. */
type Actions = Pick<UseCollectionResult<unknown, unknown>, "loadMore" | "loadItems" | "refresh">;

/** The actions of the controller held by `held`; they do nothing while none is held. */
function actionsOf(held: { readonly current: CollectionController | null }): Actions {
  return {
    loadMore: async () => {
      await held.current?.loadMore();
    },
    loadItems: async (ids: readonly string[]) => {
      await held.current?.loadItems(ids);
    },
    refresh: async () => {
      await held.current?.refresh();
    },
  };
}

/** What the hook returns, from the entry, what it shows of it and the actions. */
function resultOf<Item, Row>(
  entry: CollectionEntry | null | undefined,
  view: CollectionView<{ readonly id: string }>,
  active: boolean,
  actions: Actions,
): UseCollectionResult<Item, Row> {
  const state = entry?.state ?? null;
  const error = entry?.error ?? null;
  return {
    items: view.items as readonly Item[],
    index: view.index as readonly Row[] | undefined,
    byId: view.byId as ReadonlyMap<string, Item>,
    totalCount: state?.totalCount ?? null,
    hasMore: (state?.nextCursor ?? null) !== null,
    clamped: state?.clamped ?? false,
    indexTruncated: state?.indexTruncated ?? false,
    isLoading: active && state === null && error === null,
    isLoadingMore: entry?.loadingMore ?? false,
    error,
    ...actions,
  };
}

/** `qd.<service>.<collection>.useCollection(scope, options)`. A `null` or empty scope holds nothing. */
export function useCollection<Item, Row = IndexRow>(
  target: CollectionTarget,
  scope: string | null | undefined,
  options: UseCollectionOptions = {},
): UseCollectionResult<Item, Row> {
  const { connection, queryClient, live, awaiting } = useLiveData(
    `${target.service}.${target.collection}.useCollection`,
  );
  const scopeValue = typeof scope === "string" ? scope : "";
  const active = options.enabled !== false && scopeValue !== "";
  const loadAll = options.load === "all";
  const { limit } = options;
  const held = useRef<CollectionController | null>(null);
  useEffect(() => {
    if (!active) {
      return undefined;
    }
    const holding = live.collections.subscribe(target, scopeValue, { limit, loadAll });
    held.current = holding.controller;
    return () => {
      held.current = null;
      holding.release();
    };
  }, [live, target, scopeValue, active, limit, loadAll]);
  const overlays = useOverlayView(queryClient, target.service);
  const userId = useUserId(connection);
  const { data: cached } = useQuery(
    entryQuery<CollectionEntry>(collectionKey(target.service, target.collection, scopeValue)),
  );
  // Disabled, or awaiting new credentials' hello, it shows nothing of what is cached.
  const entry = active && !awaiting ? cached : undefined;
  const predicate = viewPredicate(target.def, options.view);
  const state = entry?.state ?? null;
  const shown = useMemo(
    () =>
      state === null
        ? NOTHING
        : showCollection(state, {
            view: predicate,
            who: { userId: userId ?? "" },
            overlay: (row) => overlays.apply(row, { collection: target.collection }),
          }),
    [state, predicate, userId, overlays, target.collection],
  );
  const actions = useMemo(() => actionsOf(held), []);
  return useMemo(
    () => resultOf<Item, Row>(entry, shown, active, actions),
    [entry, shown, active, actions],
  );
}
