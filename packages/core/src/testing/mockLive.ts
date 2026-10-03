// The live members of a mock client (`mockClient.ts`): `useEntity`,
// `useEntities` and each collection's `useCollection`, showing what the test
// set through their controls (`mockRow`, `mockScope`, ...) instead of
// subscribing over a socket. They return what the real hooks return
// (`client/live/useEntity.ts`, `client/live/useCollection.ts`): a row or a
// scope nobody set is loading, a view runs the contract's predicate over the
// index rows made from the items, and a component re-renders when the test
// changes what it shows.

import { useSyncExternalStore } from "react";
import { indexRowFromItem, type IndexRow } from "../client/live/collectionIndex";
import type { UseCollectionOptions, UseCollectionResult } from "../client/live/useCollection";
import type {
  UseEntitiesResult,
  UseEntityOptions,
  UseEntityResult,
} from "../client/live/useEntity";
import { viewPredicate } from "../client/live/views";
import type { CollectionDef, Viewer } from "../contract/collections";
import type { AnyContract } from "../contract/defineContract";
import type { QuickdrawError } from "../protocol/errors";
import { mockAdminNamespace } from "./mockAdmin";
import type { EntityMock, MockScope } from "./mockTypes";

/** What one mocked row shows: the row, its removal, or an error. */
type RowState =
  | { readonly row: { readonly id: string } }
  | { readonly removed: true }
  | { readonly error: QuickdrawError };

/** What one mocked scope shows: its items, or an error. */
type ScopeState =
  | (MockScope & { readonly items: readonly { readonly id: string }[] })
  | { readonly error: QuickdrawError };

/** The rows and scopes of one mock client, and the hooks' views of them. */
export interface MockStore {
  readonly subscribe: (listener: () => void) => () => void;
  /** The value `build` makes for `key`, the same object until the store changes. */
  read<T>(key: string, build: () => T): T;
  row(service: string, id: string): RowState | undefined;
  setRow(service: string, id: string, state: RowState): void;
  scope(service: string, collection: string, scope: string): ScopeState | undefined;
  setScope(service: string, collection: string, scope: string, state: ScopeState): void;
  /** Forgets every row and scope; `quiet` tells no hook that shows them (they are about to unmount). */
  clear(quiet?: boolean): void;
}

function keyOf(...parts: readonly string[]): string {
  return parts.join("\u0000");
}

/** Creates the store of one mock client. */
export function createMockStore(): MockStore {
  const rows = new Map<string, RowState>();
  const scopes = new Map<string, ScopeState>();
  const views = new Map<string, unknown>();
  const listeners = new Set<() => void>();
  const changed = (): void => {
    views.clear();
    for (const listener of [...listeners]) {
      listener();
    }
  };
  return {
    subscribe(listener) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    read<T>(key: string, build: () => T): T {
      if (!views.has(key)) {
        views.set(key, build());
      }
      return views.get(key) as T;
    },
    row: (service, id) => rows.get(keyOf(service, id)),
    setRow(service, id, state) {
      rows.set(keyOf(service, id), state);
      changed();
    },
    scope: (service, collection, scope) => scopes.get(keyOf(service, collection, scope)),
    setScope(service, collection, scope, state) {
      scopes.set(keyOf(service, collection, scope), state);
      changed();
    },
    clear(quiet = false) {
      rows.clear();
      scopes.clear();
      if (quiet) {
        views.clear();
      } else {
        changed();
      }
    },
  };
}

/** What `useEntity` shows of a mocked row. */
function rowResult(state: RowState | undefined, active: boolean): UseEntityResult<unknown> {
  if (state === undefined) {
    return { data: undefined, isLoading: active, isRemoved: false, error: null };
  }
  if ("row" in state) {
    return { data: state.row, isLoading: false, isRemoved: false, error: null };
  }
  if ("removed" in state) {
    return { data: undefined, isLoading: false, isRemoved: true, error: null };
  }
  return { data: undefined, isLoading: false, isRemoved: false, error: state.error };
}

/** What `useEntities` shows of the mocked rows `ids`. */
function rowsResult(
  store: MockStore,
  service: string,
  ids: readonly string[],
  active: boolean,
): UseEntitiesResult<unknown> {
  const data: unknown[] = [];
  const byId = new Map<string, unknown>();
  const errors = new Map<string, QuickdrawError>();
  let isLoading = false;
  for (const id of ids) {
    const shows = active && id !== "";
    const shown = rowResult(shows ? store.row(service, id) : undefined, shows);
    data.push(shown.data);
    if (shown.data !== undefined) {
      byId.set(id, shown.data);
    }
    if (shown.error !== null) {
      errors.set(id, shown.error);
    }
    isLoading ||= shown.isLoading;
  }
  return { data, byId, isLoading, error: errors.values().next().value ?? null, errors };
}

const idle = (): Promise<void> => Promise.resolve();

/** A mocked scope with nothing in it yet. */
function emptyScope(active: boolean): UseCollectionResult<unknown, IndexRow> {
  return {
    items: [],
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

function useMockRow(
  store: MockStore,
  service: string,
  id: string | null | undefined,
  options: UseEntityOptions = {},
): UseEntityResult<unknown> {
  const rowId = typeof id === "string" ? id : "";
  const active = options.enabled !== false && rowId !== "";
  const read = (): UseEntityResult<unknown> =>
    store.read(keyOf("row", service, rowId, String(active)), () =>
      rowResult(active ? store.row(service, rowId) : undefined, active),
    );
  return useSyncExternalStore(store.subscribe, read, read);
}

function useMockRows(
  store: MockStore,
  service: string,
  ids: readonly string[],
  options: UseEntityOptions = {},
): UseEntitiesResult<unknown> {
  const rowIds = ids.map((id) => (typeof id === "string" ? id : ""));
  const active = options.enabled !== false;
  const read = (): UseEntitiesResult<unknown> =>
    store.read(keyOf("rows", service, String(active), ...rowIds), () =>
      rowsResult(store, service, rowIds, active),
    );
  return useSyncExternalStore(store.subscribe, read, read);
}

/** One collection of a contract, as its mock member shows it. */
interface MockCollectionTarget {
  readonly service: string;
  readonly collection: string;
  readonly def: CollectionDef;
}

function useMockScope(
  store: MockStore,
  target: MockCollectionTarget,
  who: Viewer,
  scope: string | null | undefined,
  options: UseCollectionOptions = {},
): UseCollectionResult<unknown, IndexRow> {
  const value = typeof scope === "string" ? scope : "";
  const active = options.enabled !== false && value !== "";
  const { service, collection, def } = target;
  const key = keyOf("scope", service, collection, value, options.view ?? "", String(active));
  const read = (): UseCollectionResult<unknown, IndexRow> =>
    store.read(key, () =>
      scopeResult(def, active ? store.scope(service, collection, value) : undefined, {
        view: options.view,
        who,
        active,
      }),
    );
  return useSyncExternalStore(store.subscribe, read, read);
}

/** The id of a row the test passed to `mockRow`. */
function idOf(row: unknown): string {
  const id: unknown = typeof row === "object" && row !== null ? (row as { id?: unknown }).id : "";
  if (typeof id !== "string" || id === "") {
    throw new TypeError("mockRow: the row needs a string id");
  }
  return id;
}

/** The controls of a mocked service's rows. */
function rowControls(store: MockStore, service: string): EntityMock<unknown> {
  return Object.freeze({
    mockRow(row: unknown) {
      store.setRow(service, idOf(row), { row: row as { readonly id: string } });
    },
    mockRemoved(id: string) {
      store.setRow(service, id, { removed: true });
    },
    mockError(id: string, error: QuickdrawError) {
      store.setRow(service, id, { error });
    },
  });
}

/** `qd.<service>.<collection>` of a mock client. */
function mockCollectionMember(store: MockStore, target: MockCollectionTarget, who: Viewer): object {
  return Object.freeze({
    useCollection: (scope: string | null | undefined, options?: UseCollectionOptions) =>
      useMockScope(store, target, who, scope, options),
    mockScope(scope: string, items: readonly { readonly id: string }[], extra: MockScope = {}) {
      store.setScope(target.service, target.collection, scope, { ...extra, items: [...items] });
    },
    mockError(scope: string, error: QuickdrawError) {
      store.setScope(target.service, target.collection, scope, { error });
    },
  });
}

/**
 * The live members of each contract's service on a mock client, as
 * `buildCaller` takes them: the entity hooks for a contract with an entity,
 * each carrying the controls of the rows it shows, one member per
 * collection, and `admin` for a contract with the admin kit (its `adminMeta`
 * queries run on `queryClient`, the mock's cache).
 */
export function mockLiveMembers(
  store: MockStore,
  who: Viewer,
  queryClient: Parameters<typeof mockAdminNamespace>[2],
): (
  contract: AnyContract,
  methods: Readonly<Record<string, object>>,
) => Readonly<Record<string, object>> {
  return (contract, methods) => {
    const service = contract.name;
    const members: [string, object][] = [];
    if (contract.entity !== undefined) {
      const controls = rowControls(store, service);
      const useEntity = (id: string | null | undefined, options?: UseEntityOptions) =>
        useMockRow(store, service, id, options);
      const useEntities = (ids: readonly string[], options?: UseEntityOptions) =>
        useMockRows(store, service, ids, options);
      members.push(["useEntity", Object.freeze(Object.assign(useEntity, controls))]);
      members.push(["useEntities", Object.freeze(Object.assign(useEntities, controls))]);
    }
    for (const [collection, def] of Object.entries(contract.collections)) {
      members.push([collection, mockCollectionMember(store, { service, collection, def }, who)]);
    }
    members.push(...Object.entries(mockAdminNamespace(contract, methods, queryClient)));
    return Object.freeze(Object.fromEntries(members));
  };
}
