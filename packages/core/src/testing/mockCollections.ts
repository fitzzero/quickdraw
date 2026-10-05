// The collections of a mock client (`mockLive.ts`): each collection's
// `useCollection`, showing the scope the test set (`mockScope`) instead of
// subscribing over a socket, as the real hook returns it
// (`client/live/useCollection.ts`): a scope nobody set is loading, and a
// view runs the contract's predicate over the index rows made from the
// items, for the session's user, or under a `$Provider` with a `session`
// prop for that session's (`mockScope.ts`).

import { useSyncExternalStore } from "react";
import { indexRowFromItem, type IndexRow } from "../client/live/collectionIndex";
import type { UseCollectionOptions, UseCollectionResult } from "../client/live/memberTypes";
import { viewPredicate } from "../client/live/views";
import type { CollectionDef, Viewer } from "../contract/collections";
import type { QuickdrawError } from "../protocol/errors";
import type { MockStore, ScopeState } from "./mockLive";
import { sessionIn, useSessionScope } from "./mockScope";
import type { MockScope, SessionState } from "./mockTypes";

function keyOf(...parts: readonly string[]): string {
  return parts.join("\u0000");
}

const idle = (): Promise<void> => Promise.resolve();

/** A mock shows no optimistic additions, so none is ever pending. */
const NONE_PENDING: ReadonlySet<string> = new Set();

/** A mocked scope with nothing in it yet. */
function emptyScope(active: boolean): UseCollectionResult<unknown, IndexRow> {
  return {
    items: [],
    pending: NONE_PENDING,
    // A mock's mutations add nothing, so nothing is refused either.
    refused: [],
    index: undefined,
    byId: new Map(),
    totalCount: null,
    hasMore: false,
    clamped: false,
    indexTruncated: false,
    isLoading: active,
    isLoadingMore: false,
    error: null,
    loadMore: idle,
    loadItems: idle,
    refresh: idle,
  };
}

/** What `useCollection` shows of a mocked scope, through `view` for `who`. */
function scopeResult(
  def: CollectionDef,
  state: ScopeState | undefined,
  options: { readonly view: string | undefined; readonly who: Viewer; readonly active: boolean },
): UseCollectionResult<unknown, IndexRow> {
  const empty = emptyScope(options.active);
  if (state === undefined) {
    return empty;
  }
  if ("error" in state) {
    return { ...empty, isLoading: false, error: state.error };
  }
  const selects = viewPredicate(def, options.view);
  const keep = (row: Readonly<Record<string, unknown>>): boolean =>
    selects === undefined || selects(row, options.who);
  const index =
    def.index === undefined
      ? undefined
      : state.items.map((item) => indexRowFromItem(def, item)).filter(keep);
  const members = new Set(index?.map((row) => row.id));
  const items = state.items.filter((item) =>
    index === undefined ? keep(item as Readonly<Record<string, unknown>>) : members.has(item.id),
  );
  return {
    ...empty,
    items,
    index,
    byId: new Map(items.map((item) => [item.id, item])),
    totalCount: state.totalCount ?? state.items.length,
    hasMore: state.hasMore ?? false,
    isLoading: false,
  };
}

/** One collection of a contract, as its mock member shows it. */
interface MockCollectionTarget {
  readonly service: string;
  readonly collection: string;
  readonly def: CollectionDef;
}

/**
 * Who the views select members for: the session's user once known, as the
 * real views read the hello; under a `$Provider` with a `session` prop,
 * that session's (`mockScope.ts`).
 */
function viewerOf(session: SessionState): Viewer {
  return { userId: session.isKnown ? (session.userId ?? "") : "" };
}

function useMockScope(
  store: MockStore,
  target: MockCollectionTarget,
  scope: string | null | undefined,
  options: UseCollectionOptions = {},
): UseCollectionResult<unknown, IndexRow> {
  const value = typeof scope === "string" ? scope : "";
  const active = options.enabled !== false && value !== "";
  const { service, collection, def } = target;
  const sessionScope = useSessionScope(store);
  const read = (): UseCollectionResult<unknown, IndexRow> => {
    const who = viewerOf(sessionIn(store, sessionScope));
    // The viewer is part of the key: two providers' sessions may see one scope's views apart.
    const view = options.view ?? "";
    const key = keyOf("scope", service, collection, value, view, String(active), who.userId);
    return store.read(key, () =>
      scopeResult(def, active ? store.scope(service, collection, value) : undefined, {
        view: options.view,
        who,
        active,
      }),
    );
  };
  return useSyncExternalStore(store.subscribe, read, read);
}

/** `qd.<service>.<collection>` of a mock client. */
export function mockCollectionMember(store: MockStore, target: MockCollectionTarget): object {
  return Object.freeze({
    useCollection: (scope: string | null | undefined, options?: UseCollectionOptions) =>
      useMockScope(store, target, scope, options),
    mockScope(scope: string, items: readonly { readonly id: string }[], extra: MockScope = {}) {
      store.setScope(target.service, target.collection, scope, { ...extra, items: [...items] });
    },
    mockError(scope: string, error: QuickdrawError) {
      store.setScope(target.service, target.collection, scope, { error });
    },
  });
}
