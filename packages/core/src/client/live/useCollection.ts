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
// - both with the overlays of optimistic mutations laid over them, and the
//   items they added (`cache.addItem`) in their place; `pending` names those
//   whose call is in flight, and `checking` those among them whose call's
//   outcome is unknown until the scope's next load says;
// - `refused`: the items added with `onRefused: "keep"` whose call the
//   server refused, with the error, until the app dismisses one or sends its
//   call again (finding F6.4 of the quickdraw-chat migration).

import { useQuery } from "@tanstack/react-query";
import { useEffect, useMemo, useRef } from "react";
import type { QuickdrawError } from "../../protocol/errors";
import { collectionKey } from "../keys";
import type { CollectionController } from "./collectionController";
import type { IndexRow } from "./collectionIndex";
import type { CollectionEntry, CollectionTarget } from "./collectionLoads";
import { entryQuery } from "./host";
import {
  useLiveData,
  useOverlayView,
  useRefusedItems,
  useUserId,
  type RefusedItem,
} from "./liveHooks";
import { showCollection, viewPredicate, type CollectionView } from "./views";

export type { RefusedItem };

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
  /**
   * The items loaded among the members shown, in order, with the items
   * optimistic updates added (`cache.addItem`) in their place until the
   * scope's own copies arrive.
   */
  readonly items: readonly Item[];
  /**
   * The ids of the items shown that an optimistic update added and whose
   * call is in flight: style them as sending. Empty when there are none.
   */
  readonly pending: ReadonlySet<string>;
  /**
   * The ids among `pending` whose call's outcome is unknown: its connection
   * dropped after it was sent, or it timed out, so the server may have made
   * the write. Show them as checking. Each ends with the scope's next load:
   * its own copy shows when the scope holds its id, and a load that answers
   * without it refuses it (into `refused` with `onRefused: "keep"`). Only an
   * id the client made, which the server keeps, can be found: give an item
   * one when the app may send its call again. Empty when there are none.
   */
  readonly checking: ReadonlySet<string>;
  /**
   * The items an optimistic update added with `onRefused: "keep"` whose call
   * was refused, oldest first, each with its error, `dismiss()` and
   * `retry()`: not among `items`, so show them where the app shows a failed
   * send. `retry()` sends the same call again; send it only when the call is
   * idempotent (an id the client made, which the server keeps), since a
   * refusal after an unknown outcome may follow a write the server made.
   * Empty when there are none.
   */
  readonly refused: readonly RefusedItem<Item>[];
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

const NONE_PENDING: ReadonlySet<string> = new Set();

/** What the hook shows, and the ids among it of additions whose call is in flight, or of unknown outcome. */
interface Shown extends CollectionView<{ readonly id: string }> {
  readonly pending: ReadonlySet<string>;
  readonly checking: ReadonlySet<string>;
}

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
  view: Shown,
  refused: readonly RefusedItem<unknown>[],
  active: boolean,
  actions: Actions,
): UseCollectionResult<Item, Row> {
  const state = entry?.state ?? null;
  const error = entry?.error ?? null;
  return {
    items: view.items as readonly Item[],
    pending: view.pending,
    checking: view.checking,
    refused: refused as readonly RefusedItem<Item>[],
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
  const shown = useMemo((): Shown => {
    if (state === null) {
      return { ...NOTHING, pending: NONE_PENDING, checking: NONE_PENDING };
    }
    const added = overlays.added(target.collection, scopeValue);
    const view = showCollection(state, {
      view: predicate,
      who: { userId: userId ?? "" },
      overlay: (row) => overlays.apply(row, { collection: target.collection }),
      added: added.map((addition) => addition.item),
      shape: target.def,
    });
    const sending = added.filter((addition) => addition.pending && view.byId.has(addition.item.id));
    const unknown = sending.filter((addition) => addition.unknown);
    return {
      ...view,
      pending:
        sending.length === 0 ? NONE_PENDING : new Set(sending.map((addition) => addition.item.id)),
      checking:
        unknown.length === 0 ? NONE_PENDING : new Set(unknown.map((addition) => addition.item.id)),
    };
  }, [state, predicate, userId, overlays, target.collection, target.def, scopeValue]);
  const refused = useRefusedItems(
    queryClient,
    overlays,
    target.collection,
    active && !awaiting ? scopeValue : "",
  );
  const actions = useMemo(() => actionsOf(held), []);
  return useMemo(
    () => resultOf<Item, Row>(entry, shown, refused, active, actions),
    [entry, shown, refused, active, actions],
  );
}
