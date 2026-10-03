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
//   same fields (the server may have normalized them), until the server's
//   data for the row catches up: a frame (or subscribe reply) whose revision
//   is newer than every revision of the row seen before the write
//   (`observe`), or a read sent after the call succeeded (`read`). Revisions
//   are compared, never arrival order: a read that started before the write
//   finished, or a frame from an earlier flush, does not end the layer. A
//   mutation reply carries no revision (the server flushes after it
//   answers), so the threshold is the newest revision seen before the reply.
// - Only fields the row already has are overlaid, so a projection shows the
//   fields it carries and nothing else.
//
// The query hooks apply overlays to methods whose output is a projection
// (one row, `nullable(...)` or `listOf(...)`); the live-data hooks apply them
// to entities and collection items through the same `applyOverlay`.
//
// React-free: one store per `QueryClient`.

import type { QueryClient } from "@tanstack/react-query";
import type { MethodOutput } from "../contract/methods";
import type { Revision } from "../protocol/envelope";
import { isRecord } from "../protocol/guards";

/** A row as overlays find it: any object with a string `id`. */
type Row = Readonly<Record<string, unknown>> & { readonly id: string };

/**
 * What a custom optimistic update writes layers through, for one mutation
 * call. Every layer belongs to that call: dropped if it fails, kept after it
 * succeeds until the server's data for the row catches up.
 */
export interface OptimisticCache<
  Entity = Record<string, unknown>,
  Items extends Record<string, unknown> = Record<string, Record<string, unknown>>,
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
}

/**
 * A mutation's `optimistic` option: `false` for none, or a function that
 * writes the layers itself. Left out, the default applies (see the top of
 * this file).
 */
export type OptimisticUpdate<Input, Cache = OptimisticCache> = (input: Input, cache: Cache) => void;

/** The overlays of one `QueryClient`. */
export interface OverlayStore {
  /**
   * `row` as the overlays of `service` show it: their fields over its own,
   * or `undefined` when one hides it. `collection` names the collection
   * `row` is an item of, so item-only layers apply to it. Returns `row`
   * itself when no layer changes it.
   */
  applyOverlay<T>(service: string, row: T, collection?: string): T | undefined;
  /**
   * A frame or subscribe reply carrying revision `rev` of the row arrived:
   * it ends the layers of finished calls that it is newer than.
   */
  observe(service: string, id: string, rev: Revision): void;
  /** The store's clock, which a read takes when it is sent, for `read`. */
  now(): number;
  /** A read sent at `sentAt` (from `now`) returned these rows: it ends the layers of calls that finished before it. */
  read(service: string, ids: Iterable<string>, sentAt: number): void;
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
  apply<T>(row: T, collection?: string): T | undefined;
}

/** One layer of one mutation call. */
interface Layer {
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
}

/** What a mutation call does with the store: open layers, then finish or drop them. */
interface StoreInternals extends OverlayStore {
  add(service: string, id: string, layer: Pick<Layer, "collection" | "removed" | "fields">): Layer;
  finish(layers: readonly Layer[], data: unknown): void;
  discard(layers: readonly Layer[]): void;
}

/** The most layers a store keeps; past it the oldest finished ones go first. */
const MAX_LAYERS = 1000;

/** The most rows whose last revision a store remembers. */
const MAX_REVISIONS = 1000;

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
  readonly revisions: Map<string, Revision>;
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
      apply: <T>(row: T, collection?: string) => applyOverlay(layers, service, row, collection),
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

function remember(layers: Layers, key: string, rev: Revision): void {
  const known = layers.revisions.get(key);
  layers.revisions.delete(key);
  layers.revisions.set(key, known === undefined ? rev : Math.max(known, rev));
  for (const old of layers.revisions.keys()) {
    if (layers.revisions.size <= MAX_REVISIONS) {
      break;
    }
    layers.revisions.delete(old);
  }
}

function observe(layers: Layers, service: string, id: string, rev: Revision): void {
  if (typeof rev !== "number" || !Number.isFinite(rev)) {
    return;
  }
  const key = rowKey(service, id);
  remember(layers, key, rev);
  const dropped: Layer[] = [];
  for (const layer of layers.byRow.get(key) ?? []) {
    if (layer.finished === undefined) {
      // The server flushes a write after answering it, so a frame that
      // arrives before the call's reply is from an earlier flush.
      layer.base = layer.base === undefined ? rev : Math.max(layer.base, rev);
    } else if (layer.base === undefined || rev > layer.base) {
      dropped.push(layer);
    }
  }
  discard(layers, dropped);
}

function read(layers: Layers, service: string, ids: Iterable<string>, sentAt: number): void {
  const dropped: Layer[] = [];
  for (const id of ids) {
    for (const layer of layers.byRow.get(rowKey(service, id)) ?? []) {
      if (layer.finished !== undefined && layer.finished <= sentAt) {
        dropped.push(layer);
      }
    }
  }
  discard(layers, dropped);
}

/** Drops `dropped` and tells the listeners. */
function discard(layers: Layers, dropped: readonly Layer[]): void {
  const removed = dropped.filter((layer) => remove(layers, layer));
  changed(
    layers,
    removed.map((layer) => layer.service),
  );
}

function applyOverlay<T>(
  layers: Layers,
  service: string,
  row: T,
  collection?: string,
): T | undefined {
  if (!isRow(row)) {
    return row;
  }
  let shown: Row = row;
  for (const layer of layers.byRow.get(rowKey(service, row.id)) ?? []) {
    if (layer.collection === undefined || layer.collection === collection) {
      if (layer.removed) {
        return undefined;
      }
      shown = overlay(shown, layer.fields);
    }
  }
  return shown as T;
}

function createStore(): StoreInternals {
  const layers: Layers = {
    byRow: new Map(),
    revisions: new Map(),
    views: new Map(),
    listeners: new Set(),
    count: 0,
    clock: 0,
  };
  return Object.freeze({
    applyOverlay: <T>(service: string, row: T, collection?: string) =>
      applyOverlay(layers, service, row, collection),
    observe: (service: string, id: string, rev: Revision) => {
      observe(layers, service, id, rev);
    },
    now: () => layers.clock,
    read: (service: string, ids: Iterable<string>, sentAt: number) => {
      read(layers, service, ids, sentAt);
    },
    subscribe(listener: () => void): () => void {
      layers.listeners.add(listener);
      return () => {
        layers.listeners.delete(listener);
      };
    },
    view: (service: string) => viewOf(layers, service),
    add(service: string, id: string, made: Pick<Layer, "collection" | "removed" | "fields">) {
      const key = rowKey(service, id);
      const layer: Layer = {
        ...made,
        key,
        service,
        id,
        finished: undefined,
        base: layers.revisions.get(key),
      };
      layers.byRow.set(key, [...(layers.byRow.get(key) ?? []), layer]);
      layers.count += 1;
      trim(layers);
      changed(layers, [service]);
      return layer;
    },
    finish(finished: readonly Layer[], data: unknown): void {
      layers.clock += 1;
      for (const layer of finished) {
        layer.finished = layers.clock;
        layer.fields = repliedFields(layer, data);
      }
      changed(
        layers,
        finished.map((layer) => layer.service),
      );
    },
    discard(dropped: readonly Layer[]): void {
      discard(layers, dropped);
    },
  });
}

function storeOf(queryClient: QueryClient): StoreInternals {
  let store = stores.get(queryClient);
  if (store === undefined) {
    store = createStore();
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
 * How a method's output holds rows of its service: one row (`"entity"` or a
 * projection name), one row or `null` (`nullable(...)`), or a list of rows
 * (`listOf(...)`). A schema output holds none.
 */
export type RowShape = "one" | "nullable" | "list";

/** The row shape of a method's output, or `undefined` for a schema output. */
export function rowShapeOf(output: MethodOutput | undefined): RowShape | undefined {
  if (typeof output === "string") {
    return "one";
  }
  if (!isRecord(output) || "~standard" in output) {
    return undefined;
  }
  if (output.kind === "nullable") {
    return "nullable";
  }
  return output.kind === "list" ? "list" : undefined;
}

/** The ids of the rows a result of shape `shape` holds. */
export function rowIdsOf(shape: RowShape, data: unknown): string[] {
  const rows: unknown[] = shape === "list" ? (Array.isArray(data) ? data : []) : [data];
  return rows.filter(isRow).map((row) => row.id);
}

/**
 * A result of shape `shape` as `view` shows it. A hidden row leaves a list
 * and makes a `nullable` result `null`; a result that must be a row keeps
 * it. Returns `data` itself when no overlay changes it.
 */
export function showRows<T>(view: OverlayView, shape: RowShape, data: T): T {
  if (shape !== "list") {
    const shown = view.apply(data);
    if (shown === undefined) {
      return (shape === "nullable" ? null : data) as T;
    }
    return shown;
  }
  if (!Array.isArray(data)) {
    return data;
  }
  const rows: unknown[] = [];
  let same = true;
  for (const row of data as unknown[]) {
    const shown = view.apply(row);
    same &&= shown === row;
    if (shown !== undefined) {
      rows.push(shown);
    }
  }
  return (same ? data : rows) as T;
}

/** The method a mutation calls, as its default optimistic update needs it. */
export interface OptimisticTarget {
  /** The service's name on the wire. */
  readonly service: string;
  /** True when the method's output is `"entity"`: its calls are optimistic by default. */
  readonly entityOutput: boolean;
}

function cacheFor(store: StoreInternals, service: string, opened: Layer[]): OptimisticCache {
  const fieldsOf = (fields: unknown): Readonly<Record<string, unknown>> =>
    isRecord(fields) ? { ...fields } : {};
  return Object.freeze({
    patchEntity(id: string, fields: Partial<Record<string, unknown>>): void {
      opened.push(
        store.add(service, id, { collection: undefined, removed: false, fields: fieldsOf(fields) }),
      );
    },
    removeEntity(id: string): void {
      opened.push(store.add(service, id, { collection: undefined, removed: true, fields: {} }));
    },
    patchItem(collection: string, id: string, fields: Partial<Record<string, unknown>>): void {
      opened.push(store.add(service, id, { collection, removed: false, fields: fieldsOf(fields) }));
    },
  });
}

/** The layers a call opens: the custom update's, or the default's. */
function openLayers(
  store: StoreInternals,
  target: OptimisticTarget,
  optimistic: OptimisticUpdate<unknown> | undefined,
  input: unknown,
): Layer[] {
  const opened: Layer[] = [];
  const cache = cacheFor(store, target.service, opened);
  try {
    if (optimistic !== undefined) {
      optimistic(input, cache);
    } else if (target.entityOutput && isRow(input)) {
      const { id, ...fields } = input;
      cache.patchEntity(id, fields);
    }
  } catch (error) {
    store.discard(opened);
    throw error;
  }
  return opened;
}

/**
 * Runs one mutation call with its optimistic layers: opens them, sends the
 * call with `send`, then finishes them with the reply or drops them when the
 * call fails.
 */
export async function mutateOptimistically<T>(
  queryClient: QueryClient,
  target: OptimisticTarget,
  optimistic: false | OptimisticUpdate<unknown> | undefined,
  input: unknown,
  send: () => Promise<T>,
): Promise<T> {
  if (optimistic === false) {
    return await send();
  }
  const store = storeOf(queryClient);
  const opened = openLayers(store, target, optimistic, input);
  if (opened.length === 0) {
    return await send();
  }
  try {
    const data = await send();
    store.finish(opened, data);
    return data;
  } catch (error) {
    store.discard(opened);
    throw error;
  }
}
