// One mutation call's optimistic update (RFC 0003 section 11.4): the layers
// and additions it opens in the overlay store (`optimistic.ts`) when it is
// sent, finished with its reply or dropped when it fails. The default
// update of a mutation whose input has `id` and whose output is `"entity"`
// overlays the input's other fields on that row; a custom one writes
// through the `OptimisticCache` it is given (`patchEntity`, `removeEntity`,
// `patchItem`, `addItem`, `addEntity`).
//
// React-free.

import type { QueryClient } from "@tanstack/react-query";
import type { CollectionDef } from "../contract/collections";
import { isRecord } from "../protocol/guards";
import { entityScopes, newItem, type AddedRow } from "./additions";
import {
  storeOf,
  type OptimisticCache,
  type OptimisticUpdate,
  type Opened,
  type StoreInternals,
} from "./optimistic";

/** A row as an update finds its input: any object with a string `id`. */
function isRow(value: unknown): value is AddedRow {
  return isRecord(value) && typeof value.id === "string";
}

/** The method a mutation calls, as its default optimistic update needs it. */
export interface OptimisticTarget {
  /** The service's name on the wire. */
  readonly service: string;
  /** True when the method's output is `"entity"`: its calls are optimistic by default. */
  readonly entityOutput: boolean;
  /** The collections of the service's contract, for `addEntity`. */
  readonly collections?: Readonly<Record<string, CollectionDef>>;
}

function cacheFor(
  store: StoreInternals,
  target: OptimisticTarget,
  opened: Opened,
): OptimisticCache {
  const { service } = target;
  const fieldsOf = (fields: unknown): Readonly<Record<string, unknown>> =>
    isRecord(fields) ? { ...fields } : {};
  const addTo = (collection: string, scope: unknown, item: AddedRow): void => {
    if (typeof scope !== "string" || scope === "") {
      throw new TypeError("addItem: the scope must be the scope's value, a non-empty string");
    }
    opened.additions.push(store.addItem(service, collection, scope, item));
  };
  return Object.freeze({
    patchEntity(id: string, fields: Partial<Record<string, unknown>>): void {
      opened.layers.push(
        store.add(service, id, { collection: undefined, removed: false, fields: fieldsOf(fields) }),
      );
    },
    removeEntity(id: string): void {
      opened.layers.push(
        store.add(service, id, { collection: undefined, removed: true, fields: {} }),
      );
    },
    patchItem(collection: string, id: string, fields: Partial<Record<string, unknown>>): void {
      opened.layers.push(
        store.add(service, id, { collection, removed: false, fields: fieldsOf(fields) }),
      );
    },
    addItem(collection: string, scope: unknown, item: unknown): void {
      addTo(collection, scope, newItem("addItem", item));
    },
    addEntity(row: unknown): void {
      const item = newItem("addEntity", row);
      for (const [collection, scope] of entityScopes(target.collections ?? {}, item)) {
        addTo(collection, scope, item);
      }
    },
  });
}

/** The layers and additions a call opens: the custom update's, or the default's. */
function openLayers(
  store: StoreInternals,
  target: OptimisticTarget,
  optimistic: OptimisticUpdate<unknown> | undefined,
  input: unknown,
): Opened {
  const opened: Opened = { layers: [], additions: [] };
  const cache = cacheFor(store, target, opened);
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
 * call fails. `send` is given `replied`, to call with the reply's data the
 * moment it arrives (`CallRequest.onReply`): a frame handled after that is
 * after the reply, even when the call's promise has not settled yet, as on
 * Node, where one read of the socket can hand over the reply and the
 * flush's frames together. A `send` that never calls it has its layers
 * finished when its promise resolves.
 */
export async function mutateOptimistically<T>(
  queryClient: QueryClient,
  target: OptimisticTarget,
  optimistic: false | OptimisticUpdate<unknown> | undefined,
  input: unknown,
  send: (replied: (data: T) => void) => Promise<T>,
): Promise<T> {
  const ignore = (): void => undefined;
  if (optimistic === false) {
    return await send(ignore);
  }
  const store = storeOf(queryClient);
  const opened = openLayers(store, target, optimistic, input);
  if (opened.layers.length === 0 && opened.additions.length === 0) {
    return await send(ignore);
  }
  let finished = false;
  const replied = (data: T): void => {
    if (!finished) {
      finished = true;
      store.finish(opened, data);
    }
  };
  try {
    const data = await send(replied);
    replied(data);
    return data;
  } catch (error) {
    store.discard(opened);
    throw error;
  }
}
