// One mutation call's optimistic update (RFC 0003 section 11.4): the layers
// and additions it opens in the overlay store (`optimistic.ts`) when it is
// sent, finished with its reply or dropped when it fails (an addition made
// with `onRefused: "keep"` stays, refused, with a `retry` that sends the
// same call again; finding F6.4). A failure that leaves the outcome unknown
// (`isUnknownOutcome`) refuses no addition yet: each waits for its scope's
// next load (`additions.ts`). The default
// update of a mutation whose input has `id` and whose output is `"entity"`
// overlays the input's other fields on that row; a custom one writes
// through the `OptimisticCache` it is given (`patchEntity`, `removeEntity`,
// `patchItem`, `addItem`, `addEntity`).
//
// React-free.

import { notifyManager, type QueryClient } from "@tanstack/react-query";
import type { CollectionDef } from "../contract/collections";
import { QuickdrawError } from "../protocol/errors";
import { isRecord } from "../protocol/guards";
import { entityScopes, newItem, type AddedRow, type AddItemOptions } from "./additions";
import { isUnknownOutcome } from "./call";
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

/** `options.onRefused`, checked: true for `"keep"`. */
function keepsRefused(owner: string, options: AddItemOptions | undefined): boolean {
  const onRefused = options?.onRefused;
  if (onRefused !== undefined && onRefused !== "keep" && onRefused !== "drop") {
    throw new TypeError(`${owner}: onRefused is "keep" or "drop"`);
  }
  return onRefused === "keep";
}

/** A call's failure as the refused item shows it. */
function refusalError(error: unknown): QuickdrawError {
  return error instanceof QuickdrawError
    ? error
    : new QuickdrawError("INTERNAL", error instanceof Error ? error.message : String(error));
}

function cacheFor(
  store: StoreInternals,
  target: OptimisticTarget,
  opened: Opened,
): OptimisticCache {
  const { service } = target;
  const fieldsOf = (fields: unknown): Readonly<Record<string, unknown>> =>
    isRecord(fields) ? { ...fields } : {};
  const addTo = (collection: string, scope: unknown, item: AddedRow, keep: boolean): void => {
    if (typeof scope !== "string" || scope === "") {
      throw new TypeError("addItem: the scope must be the scope's value, a non-empty string");
    }
    opened.additions.push(store.addItem(service, collection, scope, item, keep));
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
    addItem(collection: string, scope: unknown, item: unknown, options?: AddItemOptions): void {
      addTo(collection, scope, newItem("addItem", item), keepsRefused("addItem", options));
    },
    addEntity(row: unknown, options?: AddItemOptions): void {
      const item = newItem("addEntity", row);
      const keep = keepsRefused("addEntity", options);
      for (const [collection, scope] of entityScopes(target.collections ?? {}, item)) {
        addTo(collection, scope, item, keep);
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

/** How a mutation hook runs its calls' optimistic updates (`mutation.ts`). */
export interface MutationRun {
  /**
   * Sends the call again through the hook's own mutation, for a refused
   * item's `retry()`, so the hook's `isPending` and its callbacks follow it.
   * Default: the call is sent again directly.
   */
  readonly resend?: () => Promise<unknown>;
  /**
   * Runs what a failure does to the overlays (a refusal, or an unknown
   * outcome) when the mutation's own state turns to error, so a refused
   * item shows in the same render as the hook's error. Default: at once.
   */
  readonly onFailed?: (apply: () => void) => void;
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
  run: MutationRun = {},
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
    // Kept additions stay, refused; `retry` sends the same call again, its update adding them anew.
    const refusal = {
      error: refusalError(error),
      retry:
        run.resend ?? (() => mutateOptimistically(queryClient, target, optimistic, input, send)),
    };
    const apply = (): void => {
      if (isUnknownOutcome(error)) {
        // The server may have made the write: the scopes' next loads say (`additions.ts`).
        store.unknown(opened, refusal);
      } else {
        store.refuse(opened, refusal);
      }
    };
    if (run.onFailed === undefined) {
      apply();
    } else {
      run.onFailed(apply);
    }
    throw error;
  }
}

/** What each `QueryClient`'s mutations hold back until their state turns to error, by their variables. */
const heldFailures = new WeakMap<QueryClient, Map<unknown, (() => void)[]>>();

/**
 * Runs `apply` when the mutation of `queryClient` called with `variables`
 * (that very value) turns to error, inside TanStack's notify batch of that
 * change: what the failure does to the overlays then shows in the render
 * that shows the mutation's error and `isPending` false (finding F8.3 of the
 * quickdraw-chat migration). The mutation function's call fails before
 * TanStack runs its `onError` and `onSettled` and then sets the state.
 */
export function applyWhenMutationFails(
  queryClient: QueryClient,
  variables: unknown,
  apply: () => void,
): void {
  let held = heldFailures.get(queryClient);
  if (held === undefined) {
    const byVariables = new Map<unknown, (() => void)[]>();
    held = byVariables;
    heldFailures.set(queryClient, byVariables);
    queryClient.getMutationCache().subscribe((event) => {
      if (event.type !== "updated" || event.action.type !== "error") {
        return;
      }
      const { variables: failed } = event.mutation.state;
      const waiting = byVariables.get(failed);
      byVariables.delete(failed);
      for (const run of waiting ?? []) {
        // Queued in the batch the mutation's observers are told in: one render shows both.
        notifyManager.schedule(run);
      }
    });
  }
  held.set(variables, [...(held.get(variables) ?? []), apply]);
}
