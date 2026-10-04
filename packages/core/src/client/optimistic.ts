// Optimistic mutations (RFC 0003 section 11.4): a user's own edit shows at
// once, and is undone cleanly when the server refuses it.
//
// An edit is an overlay, never a write into the cache: a layer of fields kept
// per service and row id, shown over whatever the cache holds for that row
// (`applyOverlay`). The cache keeps the server's data, so a refetch or a
// frame never has to be reconciled with a guess, and undoing an edit is
// dropping its layer.
//
// - A mutation whose input has a string `id` and whose output is `"entity"`
//   is optimistic by default: the input's other fields are overlaid on the
//   row with that id. `optimistic: false` turns it off; a function
//   `(input, cache) => void` writes its own layers with `cache.patchEntity`,
//   `cache.removeEntity` and `cache.patchItem`.
// - The layers are made when the call is sent. A refused call drops them.
// - A call that succeeds keeps them, with the values its reply holds for the
//   same fields (the server may have normalized them), for as long as cached
//   data can predate the write:
//   - data read by a request sent after the call succeeded already holds the
//     write, so a finished layer is not shown over it (`readAt`, on the
//     store's clock): the cached result of one query is refreshed without
//     taking the overlay off another that still holds the old row;
//   - a frame (`qd:e`, `qd:c`) whose revision is newer than every revision
//     of the row seen before the reply ends the layer for good (`observe`).
//     A mutation reply carries no revision, because the server flushes after
//     it answers, so that is the threshold; a frame that arrives before the
//     reply is from an earlier flush and only raises it;
//   - a reply to a read (a subscribe reply, a snapshot, a page, items by id)
//     ends the layer only when its read was sent after the call's reply: one
//     sent before may have read the row before the write, whatever its
//     revision and whenever its answer arrives;
//   - a finished layer that gets neither within 10 s is dropped, so a layer
//     on a row nothing follows (a custom one, or an unsubscribed row) cannot
//     stay forever.
//   Revisions and send order are compared, never arrival order.
// - Only fields the row already has are overlaid, so a projection shows the
//   fields it carries and nothing else.
// - An update can add a row too (`cache.addItem(collection, scope, item)`,
//   or `cache.addEntity(row)` for every collection of entity rows it
//   belongs to): a provisional item shown in the scope at once, in the
//   collection's order, flagged `pending` while the call is in flight, kept
//   beside the layers until the scope accounts for it (`additions.ts`,
//   `settleAdditions`).
//
// The query hooks apply overlays to methods whose output is a projection
// (one row, `nullable(...)` or `listOf(...)`, `overlayRows.ts`); the
// live-data hooks apply them to entities and collection items through the
// same `applyOverlay`. A store keeps at most 1,000 layers and forgets the
// oldest finished ones first. It remembers the last revision of at most
// 1,000 rows, plus every row that has a layer, so reading a large board
// cannot push those out. What one mutation call opens, finishes and drops is
// `optimisticCall.ts`.
//
// React-free: one store per `QueryClient`.

import type { QueryClient } from "@tanstack/react-query";
import type { Revision } from "../protocol/envelope";
import { isRecord } from "../protocol/guards";
import {
  createAdditions,
  type AddedItem,
  type AddedRow,
  type Addition,
  type Additions,
  type ScopeEvidence,
} from "./additions";

export type { AddedItem, ScopeEvidence } from "./additions";

/** A row as overlays find it: any object with a string `id`. */
type Row = Readonly<Record<string, unknown>> & { readonly id: string };

/**
 * A row an optimistic update adds: every field of `T` but `id`, which it may
 * give (an id the client made, which the server keeps) or leave to the
 * server.
 */
export type NewRow<T> = Omit<T, "id"> & { readonly id?: string };

/**
 * What a custom optimistic update writes layers through, for one mutation
 * call. Every layer belongs to that call: dropped if it fails, kept after it
 * succeeds until the server's data for the row catches up.
 */
export interface OptimisticCache<
  Entity = Record<string, unknown>,
  Items extends Record<string, unknown> = Record<string, Record<string, unknown>>,
  Scopes extends { readonly [K in keyof Items]: unknown } = { readonly [K in keyof Items]: string },
> {
  /** Shows `fields` over the row `id` of the mutation's service: its entity and its collection items. */
  patchEntity(id: string, fields: Partial<Entity>): void;
  /** Hides the row `id`: from lists, collections and its entity. */
  removeEntity(id: string): void;
  /** Shows `fields` over the row `id` in the items of `collection` only. */
  patchItem<K extends keyof Items & string>(
    collection: K,
    id: string,
    fields: Partial<Items[K]>,
  ): void;
  /**
   * Shows `item` in scope `scope` of `collection` at once, in the
   * collection's order (give it the `order` fields; without them it shows
   * last), flagged in `useCollection`'s `pending` while the call is in
   * flight: a create shown before the server answers. A refused call drops
   * it; the reply's `id` (the created row's) replaces its own, and the
   * scope's own copy replaces it when it arrives.
   */
  addItem<K extends keyof Items & string>(
    collection: K,
    scope: Scopes[K],
    item: NewRow<Items[K]>,
  ): void;
  /**
   * `addItem` for every collection of the service whose items are the
   * entity (`item: "entity"`) and whose scope column, and every column of
   * its `where`, `row` holds with a matching value: the scope is
   * `row[scope]`. A collection of a projection, or scoped `via` a junction,
   * takes `addItem`.
   */
  addEntity(row: NewRow<Entity>): void;
}

/**
 * A mutation's `optimistic` option: `false` for none, or a function that
 * writes the layers itself. Left out, the default applies (see the top of
 * this file).
 */
export type OptimisticUpdate<Input, Cache = OptimisticCache> = (input: Input, cache: Cache) => void;

/** Where a row being shown comes from, for {@link OverlayStore.applyOverlay}. */
export interface OverlayOptions {
  /** The collection the row is an item of: layers written with `patchItem` for it apply too. */
  readonly collection?: string;
  /**
   * When the request that read the row was sent, as `now()` was then.
   * Layers of calls that had finished by then are in the row already and
   * are not applied again. Left out, every layer applies.
   */
  readonly readAt?: number;
}

/** The overlays of one `QueryClient`. */
export interface OverlayStore {
  /**
   * `row` as the overlays of `service` show it: their fields over its own,
   * or `undefined` when one hides it. Returns `row` itself when no layer
   * changes it.
   */
  applyOverlay<T>(service: string, row: T, options?: OverlayOptions): T | undefined;
  /**
   * Revision `rev` of the row arrived. Without `readAt` it came in a frame
   * (`qd:e`, `qd:c`), which ends the layers of finished calls it is newer
   * than. With `readAt` it came in the reply to a read sent then (on this
   * store's clock: a subscribe reply, a snapshot, a page, items), which ends
   * only the layers of calls that finished before the read was sent.
   */
  observe(service: string, id: string, rev: Revision, readAt?: number): void;
  /** The store's clock: take it when sending a read, and pass it as `readAt` to show what the read returned. */
  now(): number;
  /** Calls `listener` whenever a layer is added, changed or dropped; returns the unsubscribe function. */
  subscribe(listener: () => void): () => void;
  /**
   * The overlays of `service` as one object, which stays the same until one
   * of them changes: a `useSyncExternalStore` snapshot for code that renders
   * the rows of one service.
   */
  view(service: string): OverlayView;
}

/** The overlays of one service, until one of them changes (`OverlayStore.view`). */
export interface OverlayView {
  /** `applyOverlay` for this view's service. */
  apply<T>(row: T, options?: OverlayOptions): T | undefined;
  /** The items optimistic updates added to scope `scope` of `collection`, oldest first. */
  added(collection: string, scope: string): readonly AddedItem[];
}

/** One layer of one mutation call. */
export interface Layer {
  readonly key: string;
  readonly service: string;
  readonly id: string;
  /** Applies to the items of this collection only; absent for the row everywhere. */
  readonly collection: string | undefined;
  /** Hides the row. */
  readonly removed: boolean;
  fields: Readonly<Record<string, unknown>>;
  /** The store's clock when the call succeeded; absent while it is in flight. */
  finished: number | undefined;
  /** The newest revision of the row seen before the call finished. */
  base: Revision | undefined;
  /** When a finished layer is dropped if nothing ended it before (`Date.now()` time). */
  expiresAt: number | undefined;
}

/** What one mutation call opened. */
export interface Opened {
  readonly layers: Layer[];
  readonly additions: Addition[];
}

/** What a mutation call does with the store: open layers, then finish or drop them. */
export interface StoreInternals extends OverlayStore {
  add(service: string, id: string, layer: Pick<Layer, "collection" | "removed" | "fields">): Layer;
  addItem(service: string, collection: string, scope: string, item: AddedRow): Addition;
  finish(opened: Opened, data: unknown): void;
  discard(opened: Opened): void;
  /** Ends the finished additions to a scope that it accounts for (`settleAdditions`). */
  settle(service: string, collection: string, scope: string, evidence: ScopeEvidence): void;
  /** Drops every layer and every revision seen: the cache was emptied for another user. */
  reset(): void;
}

/** The most layers a store keeps; past it the oldest finished ones go first. */
const MAX_LAYERS = 1000;

/** The most rows without a layer whose last revision a store remembers. */
const MAX_REVISIONS = 1000;

/** How long a finished layer stays when no frame and no read after its reply ends it. */
const FINISHED_LAYER_MS = 10_000;

const stores = new WeakMap<QueryClient, StoreInternals>();

function rowKey(service: string, id: string): string {
  return `${service}\u0000${id}`;
}

function isRow(value: unknown): value is Row {
  return isRecord(value) && typeof value.id === "string";
}

/** `fields` laid over `row` where `row` has the field; `row` itself when nothing changes. */
function overlay(row: Row, fields: Readonly<Record<string, unknown>>): Row {
  let next: Record<string, unknown> | undefined;
  for (const [field, value] of Object.entries(fields)) {
    if (field !== "id" && Object.hasOwn(row, field) && !Object.is(row[field], value)) {
      next ??= { ...row };
      next[field] = value;
    }
  }
  return (next ?? row) as Row;
}

/** The values `data` holds for the fields of `layer`, when `data` is its row. */
function repliedFields(layer: Layer, data: unknown): Readonly<Record<string, unknown>> {
  if (!isRow(data) || data.id !== layer.id) {
    return layer.fields;
  }
  const fields: Record<string, unknown> = { ...layer.fields };
  for (const field of Object.keys(fields)) {
    if (Object.hasOwn(data, field)) {
      fields[field] = data[field];
    }
  }
  return fields;
}

/** The layer state of one store, and the bookkeeping its methods share. */
interface Layers {
  readonly byRow: Map<string, Layer[]>;
  /** The rows optimistic updates added, per scope (`additions.ts`). */
  readonly additions: Additions;
  /** The last revision of rows without a layer, the least recently seen first. */
  readonly revisions: Map<string, Revision>;
  /** The last revision of rows with a layer, kept out of `revisions` so that churn cannot evict it. */
  readonly pinned: Map<string, Revision>;
  /** Drops the finished layers that expire first. */
  expiry: ReturnType<typeof setTimeout> | undefined;
  /** The current view of each service; a change of the service's layers drops it. */
  readonly views: Map<string, OverlayView>;
  readonly listeners: Set<() => void>;
  count: number;
  clock: number;
}

/** Drops the views of `services` and tells the listeners, when there is any. */
function changed(layers: Layers, services: Iterable<string>): void {
  const touched = new Set(services);
  if (touched.size === 0) {
    return;
  }
  for (const service of touched) {
    layers.views.delete(service);
  }
  for (const listener of [...layers.listeners]) {
    listener();
  }
}

function viewOf(layers: Layers, service: string): OverlayView {
  let view = layers.views.get(service);
  if (view === undefined) {
    view = Object.freeze({
      apply: <T>(row: T, options?: OverlayOptions) => applyOverlay(layers, service, row, options),
      added: (collection: string, scope: string) =>
        layers.additions.added(service, collection, scope),
    });
    layers.views.set(service, view);
  }
  return view;
}

function remove(layers: Layers, layer: Layer): boolean {
  const row = layers.byRow.get(layer.key);
  const index = row?.indexOf(layer) ?? -1;
  if (row === undefined || index < 0) {
    return false;
  }
  row.splice(index, 1);
  if (row.length === 0) {
    layers.byRow.delete(layer.key);
    const pinned = layers.pinned.get(layer.key);
    layers.pinned.delete(layer.key);
    if (pinned !== undefined) {
      remember(layers, layer.key, pinned);
    }
  }
  layers.count -= 1;
  return true;
}

/** Drops the oldest finished layers (or else the oldest) while the store holds too many. */
function trim(layers: Layers): void {
  while (layers.count > MAX_LAYERS) {
    const all = [...layers.byRow.values()].flat();
    const oldest = all.find((layer) => layer.finished !== undefined) ?? all[0];
    if (oldest === undefined || !remove(layers, oldest)) {
      return;
    }
  }
}

/** The last revision seen of the row `key`. */
function knownRevision(layers: Layers, key: string): Revision | undefined {
  return layers.pinned.get(key) ?? layers.revisions.get(key);
}

function remember(layers: Layers, key: string, rev: Revision): void {
  const known = knownRevision(layers, key);
  const newest = known === undefined ? rev : Math.max(known, rev);
  layers.revisions.delete(key);
  if (layers.byRow.has(key)) {
    layers.pinned.set(key, newest);
    return;
  }
  layers.revisions.set(key, newest);
  for (const old of layers.revisions.keys()) {
    if (layers.revisions.size <= MAX_REVISIONS) {
      break;
    }
    layers.revisions.delete(old);
  }
}

/**
 * Whether revision `rev` of a finished layer's row ends it: from a frame, when
 * it is newer than every revision seen before the call's reply; from the
 * reply to a read sent at `readAt`, when that read was sent after the reply.
 */
function ends(layer: Layer, rev: Revision, readAt: number | undefined): boolean {
  if (readAt !== undefined) {
    return layer.finished !== undefined && readAt >= layer.finished;
  }
  return layer.base === undefined || rev > layer.base;
}

function observe(
  layers: Layers,
  service: string,
  id: string,
  rev: Revision,
  readAt: number | undefined,
): void {
  if (typeof rev !== "number" || !Number.isFinite(rev)) {
    return;
  }
  const key = rowKey(service, id);
  remember(layers, key, rev);
  const dropped: Layer[] = [];
  for (const layer of layers.byRow.get(key) ?? []) {
    if (layer.finished === undefined) {
      // The server flushes a write after answering it, so a frame, or a read,
      // that arrives before the call's reply is from before the write.
      layer.base = layer.base === undefined ? rev : Math.max(layer.base, rev);
    } else if (ends(layer, rev, readAt)) {
      dropped.push(layer);
    }
  }
  discard(layers, dropped);
}

/** Stops the expiry of finished layers. */
function stopExpiry(layers: Layers): void {
  clearTimeout(layers.expiry);
  layers.expiry = undefined;
}

/** Drops `dropped` and `additions`, and tells the listeners. */
function discard(
  layers: Layers,
  dropped: readonly Layer[],
  additions: readonly Addition[] = [],
): void {
  const removed = dropped.filter((layer) => remove(layers, layer));
  const gone = layers.additions.remove(additions);
  if (layers.count === 0 && layers.additions.size === 0) {
    stopExpiry(layers);
  }
  changed(layers, [
    ...removed.map((layer) => layer.service),
    ...gone.map((addition) => addition.service),
  ]);
}

/** Drops the finished layers and additions whose time is up, and waits for the next to expire. */
function expire(layers: Layers): void {
  const now = Date.now();
  const isDue = (entry: { readonly expiresAt: number | undefined }): boolean =>
    entry.expiresAt !== undefined && entry.expiresAt <= now;
  discard(
    layers,
    [...layers.byRow.values()].flat().filter(isDue),
    layers.additions.all().filter(isDue),
  );
  armExpiry(layers);
}

/** Waits for the first finished layer or addition to expire, unless a wait is set already. */
function armExpiry(layers: Layers): void {
  if (layers.expiry !== undefined) {
    return;
  }
  const times = [...[...layers.byRow.values()].flat(), ...layers.additions.all()].map(
    (entry) => entry.expiresAt,
  );
  const first = Math.min(...times.filter((time) => time !== undefined));
  if (Number.isFinite(first)) {
    layers.expiry = setTimeout(
      () => {
        layers.expiry = undefined;
        expire(layers);
      },
      Math.max(0, first - Date.now()),
    );
  }
}

/** Whether `layer` shows over a row read at `readAt` and shown in `collection`. */
function applies(layer: Layer, options: OverlayOptions): boolean {
  const { collection, readAt } = options;
  const inRow = layer.finished === undefined || readAt === undefined || layer.finished > readAt;
  return inRow && (layer.collection === undefined || layer.collection === collection);
}

function applyOverlay<T>(
  layers: Layers,
  service: string,
  row: T,
  options: OverlayOptions = {},
): T | undefined {
  if (!isRow(row)) {
    return row;
  }
  let shown: Row = row;
  for (const layer of layers.byRow.get(rowKey(service, row.id)) ?? []) {
    if (applies(layer, options)) {
      if (layer.removed) {
        return undefined;
      }
      shown = overlay(shown, layer.fields);
    }
  }
  return shown as T;
}

/** Opens a layer of a call in flight over row `id` of `service`. */
function addLayer(
  layers: Layers,
  service: string,
  id: string,
  made: Pick<Layer, "collection" | "removed" | "fields">,
): Layer {
  const key = rowKey(service, id);
  const base = knownRevision(layers, key);
  const layer: Layer = {
    ...made,
    key,
    service,
    id,
    finished: undefined,
    base,
    expiresAt: undefined,
  };
  layers.byRow.set(key, [...(layers.byRow.get(key) ?? []), layer]);
  if (base !== undefined) {
    // The row has a layer now: its revision leaves the memory that churn empties.
    layers.revisions.delete(key);
    layers.pinned.set(key, base);
  }
  layers.count += 1;
  trim(layers);
  changed(layers, [service]);
  return layer;
}

/**
 * Finishes the layers and additions of a call that succeeded with `data`:
 * layers keep its values, additions take the id it names (or are dropped
 * when it names none, or when their scope holds it already), for at most 10 s.
 */
function finishLayers(layers: Layers, opened: Opened, data: unknown): void {
  layers.clock += 1;
  const expiresAt = Date.now() + FINISHED_LAYER_MS;
  for (const layer of opened.layers) {
    layer.finished = layers.clock;
    layer.fields = repliedFields(layer, data);
    layer.expiresAt = expiresAt;
  }
  // Those the reply names no id for, or whose scope holds it already, go now.
  layers.additions.finish(opened.additions, data, layers.clock, expiresAt);
  armExpiry(layers);
  changed(layers, [
    ...opened.layers.map((layer) => layer.service),
    ...opened.additions.map((addition) => addition.service),
  ]);
}

/** Drops every layer and every revision seen, and tells the views of every service shown. */
function resetLayers(layers: Layers): void {
  const services = new Set(layers.views.keys());
  for (const row of layers.byRow.values()) {
    for (const layer of row) {
      services.add(layer.service);
    }
  }
  for (const addition of layers.additions.all()) {
    services.add(addition.service);
  }
  stopExpiry(layers);
  layers.byRow.clear();
  layers.additions.clear();
  layers.revisions.clear();
  layers.pinned.clear();
  layers.count = 0;
  changed(layers, services);
}

function createStore(queryClient: QueryClient): StoreInternals {
  const layers: Layers = {
    byRow: new Map(),
    additions: createAdditions(queryClient),
    revisions: new Map(),
    pinned: new Map(),
    expiry: undefined,
    views: new Map(),
    listeners: new Set(),
    count: 0,
    clock: 0,
  };
  return Object.freeze({
    applyOverlay: <T>(service: string, row: T, options?: OverlayOptions) =>
      applyOverlay(layers, service, row, options),
    observe: (service: string, id: string, rev: Revision, readAt?: number) => {
      observe(layers, service, id, rev, readAt);
    },
    now: () => layers.clock,
    subscribe(listener: () => void): () => void {
      layers.listeners.add(listener);
      return () => {
        layers.listeners.delete(listener);
      };
    },
    view: (service: string) => viewOf(layers, service),
    add: (service: string, id: string, made: Pick<Layer, "collection" | "removed" | "fields">) =>
      addLayer(layers, service, id, made),
    addItem(service: string, collection: string, scope: string, item: AddedRow): Addition {
      const addition = layers.additions.add(service, collection, scope, item);
      changed(layers, [service]);
      return addition;
    },
    finish(opened: Opened, data: unknown): void {
      finishLayers(layers, opened, data);
    },
    discard(opened: Opened): void {
      discard(layers, opened.layers, opened.additions);
    },
    settle(service: string, collection: string, scope: string, evidence: ScopeEvidence): void {
      if (layers.additions.size > 0) {
        discard(layers, [], layers.additions.settle(service, collection, scope, evidence));
      }
    },
    reset(): void {
      resetLayers(layers);
    },
  });
}

/** The store of `queryClient`, with what a mutation call does to it (`optimisticCall.ts`). */
export function storeOf(queryClient: QueryClient): StoreInternals {
  let store = stores.get(queryClient);
  if (store === undefined) {
    store = createStore(queryClient);
    stores.set(queryClient, store);
  }
  return store;
}

/**
 * The overlay store of `queryClient`, made on first use. Code that shows
 * rows from somewhere other than a query hook (the live-data hooks, an app's
 * own cache) passes them through `applyOverlay`, and reports the revisions
 * it receives through `observe`.
 */
export function overlaysOf(queryClient: QueryClient): OverlayStore {
  return storeOf(queryClient);
}

/**
 * Drops every layer and every revision the overlay store of `queryClient`
 * holds, and tells its subscribers: the cache was emptied because another
 * user acts on the connection now (`session.ts`). A call still in flight
 * shows nothing more.
 */
export function resetOverlays(queryClient: QueryClient): void {
  stores.get(queryClient)?.reset();
}

/**
 * The state of scope `scope` of `collection` of `service` changed in the
 * cache of `queryClient` (`live/collectionController.ts`): its finished
 * additions end when that state accounts for them, because it holds the id
 * their reply named (the server's own copy is shown now), a delta just
 * applied named it, or the load just applied was sent after their call's
 * reply (`readAt`) and so would hold it if it were a member. Additions of
 * calls in flight stay.
 */
export function settleAdditions(
  queryClient: QueryClient,
  service: string,
  collection: string,
  scope: string,
  evidence: ScopeEvidence,
): void {
  stores.get(queryClient)?.settle(service, collection, scope, evidence);
}
