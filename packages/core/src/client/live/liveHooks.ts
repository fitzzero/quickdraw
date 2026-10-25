"use client";

// What the live-data hooks share: the provider's live data, the query that
// observes an entry of it, the overlays of optimistic mutations for one
// service, and the user the connection acts for.

import type { QueryClient } from "@tanstack/react-query";
import { useMemo, useSyncExternalStore } from "react";
import type { QuickdrawConnection } from "../connection";
import { serverStateOf, useAwaitingHello, useHello, useQuickdrawContext } from "../context";
import { isCheckRefusal } from "../issuer";
import type { QuickdrawError } from "../../protocol/errors";
import {
  NO_OVERLAYS,
  overlaysOf,
  storeOf,
  type OverlayView,
  type RefusedAddition,
} from "../optimistic";
import { userOf } from "../session";
import { liveDataOf, type LiveData } from "./liveData";

// What a hook observes its entry with, as the stores holding it do (`queryCache.ts`).
export { entryQuery, type EntryQueryOptions } from "./queryCache";

/**
 * The provider's connection and `QueryClient`, and their live data; `hook`
 * names the caller in errors. The hook renders again on each new hello, so
 * after another user's hello emptied the cache it shows the new entries
 * (`../session.ts`).
 */
export function useLiveData(hook: string): {
  readonly connection: QuickdrawConnection;
  readonly queryClient: QueryClient;
  readonly live: LiveData;
  /**
   * True while new credentials await their hello on a cache loaded under the
   * last ones: the hook shows nothing of what is cached (`../session.ts`).
   */
  readonly awaiting: boolean;
} {
  const { connection, queryClient } = useQuickdrawContext(hook);
  useHello(connection);
  const awaiting = useAwaitingHello(connection, queryClient);
  return { connection, queryClient, live: liveDataOf(connection, queryClient), awaiting };
}

const noOverlays = (): OverlayView => NO_OVERLAYS;

/** The overlays of `service`, re-rendering when one of them changes; none on a server and while hydrating. */
export function useOverlayView(queryClient: QueryClient, service: string): OverlayView {
  const overlays = overlaysOf(queryClient);
  const snapshot = (): OverlayView => overlays.view(service);
  return useSyncExternalStore(overlays.subscribe, snapshot, noOverlays);
}

/**
 * The user the connection acts for, from its `qd:hello`: `null` while
 * anonymous or before the hello; on a server and while hydrating, the one
 * its server state names (`../context.ts`).
 */
export function useUserId(connection: QuickdrawConnection): string | null {
  return useSyncExternalStore(
    connection.subscribe,
    () => userOf(connection.getState().hello),
    () => userOf(serverStateOf(connection).hello),
  );
}

/**
 * An item an optimistic update added with `onRefused: "keep"` whose call
 * the server refused (`useCollection().refused`).
 */
export interface RefusedItem<Item> {
  /** The fields the update gave the item, with its own id or a provisional one. */
  readonly item: Item;
  /** Why the server refused the call. */
  readonly error: QuickdrawError;
  /** Forgets it: it leaves `refused`. */
  dismiss(): void;
  /**
   * Sends the same call again, through the mutation hook that sent it (its
   * `isPending`, `onSuccess`, `onError` and `onSettled` follow the retry): it
   * leaves `refused`, and the update adds the item anew, `pending` while the
   * call is in flight. Resolves once the call settles, and never rejects: a
   * refusal shows in `refused` again, one that stopped the call before it
   * was sent included (`CANCELLED`: its user changed, or new credentials
   * await their hello), unless the cache was emptied for another user
   * meanwhile. Send it only when the call is idempotent (an id the client
   * made, which the server keeps) if its error left the outcome unknown
   * (`isUnknownOutcome`).
   */
  retry(): Promise<void>;
}

const NONE_REFUSED: readonly RefusedItem<never>[] = Object.freeze([]);

/** The refused items of a scope, as the hook returns them: each with `dismiss` and `retry`. */
function refusedItems(
  queryClient: QueryClient,
  refused: readonly RefusedAddition[],
): readonly RefusedItem<unknown>[] {
  if (refused.length === 0) {
    return NONE_REFUSED;
  }
  const store = storeOf(queryClient);
  return refused.map(({ item, error, addition }) => ({
    item,
    error,
    dismiss: () => {
      store.dismiss(addition);
    },
    retry: async () => {
      const { service, collection, scope, refusal } = addition;
      const held = store
        .view(service)
        .refused(collection, scope)
        .some((each) => each.addition === addition);
      const generation = store.generation();
      store.dismiss(addition);
      try {
        await refusal?.retry();
      } catch (again) {
        // Refused again: shown in `refused` again, with the new error. Refused before it was sent
        // (its user changed), its update never added it anew: it goes back as it was, with that
        // error, unless the cache was emptied for someone else meanwhile.
        if (
          held &&
          refusal !== undefined &&
          isCheckRefusal(again) &&
          store.generation() === generation
        ) {
          const back = store.addItem(service, collection, scope, addition.item, true);
          store.refuse({ layers: [], additions: [back] }, { retry: refusal.retry, error: again });
        }
      }
    },
  }));
}

/**
 * The items added to scope `scope` of `collection` with `onRefused: "keep"`
 * whose call was refused (`useCollection().refused`); none for an empty
 * scope (a hook that shows nothing).
 */
export function useRefusedItems(
  queryClient: QueryClient,
  overlays: OverlayView,
  collection: string,
  scope: string,
): readonly RefusedItem<unknown>[] {
  return useMemo(
    () =>
      scope === "" ? NONE_REFUSED : refusedItems(queryClient, overlays.refused(collection, scope)),
    [queryClient, overlays, collection, scope],
  );
}
