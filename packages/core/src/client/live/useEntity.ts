"use client";

// `qd.<service>.useEntity(id)` and `qd.<service>.useEntities(ids)` (RFC 0003
// sections 6, 11 and 11.5): rows of a service, live. Replaces 4.1's
// `useSubscription(serviceName, entryId)`
// (4.1 `src/client/useSubscription.ts:42-246`), which put a socket
// listener per row on the socket, merged updates in arrival order and loaded
// everything again after a reconnect.
//
// A row is subscribed while a mounted component holds it (`entityStore.ts`):
// ids asked for in one tick share one `qd:sub`, frames apply by revision, and
// a reconnect asks for each row again with the revision held, so an
// unchanged row is answered "not modified". The hooks show the row cached
// under `["qd", service, "e", id]`, as the subscriber's access tier sees it,
// with the overlays of optimistic mutations laid over it.

import { useQueries, useQuery, type QueryObserverResult } from "@tanstack/react-query";
import { useEffect, useMemo } from "react";
import type { QuickdrawError } from "../../protocol/errors";
import { entityKey } from "../keys";
import type { OverlayView } from "../optimistic";
import { EMPTY_ENTITY, type EntityEntry } from "./entities";
import { entryQuery } from "./host";
import { useLiveData, useOverlayView } from "./liveHooks";

/** Options of `useEntity` and `useEntities`. */
export interface UseEntityOptions {
  /**
   * `false` holds no subscription and shows nothing: `data` is `undefined`
   * (and `isLoading` false) even while the row is cached. Default `true`.
   */
  readonly enabled?: boolean;
}

/** What `qd.<service>.useEntity(id)` returns. */
export interface UseEntityResult<Row> {
  /**
   * The row as the subscriber's access tier sees it (fields above that tier
   * are absent), with optimistic edits laid over it; `undefined` while
   * loading, once removed, or after an error.
   */
  readonly data: Row | undefined;
  /** True until the first answer for the row. */
  readonly isLoading: boolean;
  /** True when the server says the row does not exist (deleted, or never there), or an optimistic removal hides it. */
  readonly isRemoved: boolean;
  /** Why the subscription failed or ended: `FORBIDDEN` when access is refused or revoked. */
  readonly error: QuickdrawError | null;
}

/** What `qd.<service>.useEntities(ids)` returns. */
export interface UseEntitiesResult<Row> {
  /** One entry per id, in the order of `ids`: the row, or `undefined` while loading, once removed, or after an error. */
  readonly data: readonly (Row | undefined)[];
  /** The rows shown, by id. */
  readonly byId: ReadonlyMap<string, Row>;
  /** True while any of the rows waits for its first answer. */
  readonly isLoading: boolean;
  /** The first error among the rows, or `null`. */
  readonly error: QuickdrawError | null;
  /** Each failed row's error, by id. */
  readonly errors: ReadonlyMap<string, QuickdrawError>;
}

/** What the hooks show of an entry. */
function shown<Row>(
  entry: EntityEntry<Row> | null | undefined,
  view: OverlayView,
  active: boolean,
): UseEntityResult<Row> {
  const held = entry ?? (EMPTY_ENTITY as EntityEntry<Row>);
  const data = held.data === undefined ? undefined : view.apply(held.data, { readAt: held.readAt });
  return {
    data,
    isLoading: active && held.data === undefined && !held.removed && held.error === null,
    isRemoved: held.removed || (held.data !== undefined && data === undefined),
    error: held.error,
  };
}

/** `qd.<service>.useEntity(id, options)`: row `id` of `service`, live. A `null` or empty id holds nothing. */
export function useEntity<Row>(
  service: string,
  id: string | null | undefined,
  options: UseEntityOptions = {},
): UseEntityResult<Row> {
  const { queryClient, live, awaiting } = useLiveData(`${service}.useEntity`);
  const rowId = typeof id === "string" ? id : "";
  const active = options.enabled !== false && rowId !== "";
  useEffect(
    () => (active ? live.entities.subscribe(service, [rowId]) : undefined),
    [live, service, rowId, active],
  );
  const view = useOverlayView(queryClient, service);
  const { data: entry } = useQuery(entryQuery<EntityEntry<Row>>(entityKey(service, rowId)));
  // Disabled, or awaiting new credentials' hello, it shows nothing of what is cached.
  const held = active && !awaiting ? entry : undefined;
  return useMemo(() => shown(held, view, active), [held, view, active]);
}

const NO_ENTRIES: readonly undefined[] = Object.freeze([]);

/** The entries of `useQueries`' results: a stable function, so TanStack keeps its combined result while they do not change. */
function entriesOf<Row>(
  results: readonly QueryObserverResult<EntityEntry<Row> | null>[],
): (EntityEntry<Row> | null | undefined)[] {
  return results.map((result) => result.data);
}

/** What `useEntities` shows of the entries of `ids`. */
function combined<Row>(
  ids: readonly string[],
  entries: readonly (EntityEntry<Row> | null | undefined)[],
  view: OverlayView,
  active: boolean,
): UseEntitiesResult<Row> {
  const data: (Row | undefined)[] = [];
  const byId = new Map<string, Row>();
  const errors = new Map<string, QuickdrawError>();
  let isLoading = false;
  for (const [position, id] of ids.entries()) {
    const row = shown(entries[position], view, active && id !== "");
    data.push(row.data);
    if (row.data !== undefined) {
      byId.set(id, row.data);
    }
    if (row.error !== null) {
      errors.set(id, row.error);
    }
    isLoading ||= row.isLoading;
  }
  return { data, byId, isLoading, error: errors.values().next().value ?? null, errors };
}

/**
 * `qd.<service>.useEntities(ids, options)`: rows `ids` of `service`, live,
 * subscribed together (one `qd:sub` per 500 ids).
 */
export function useEntities<Row>(
  service: string,
  ids: readonly string[],
  options: UseEntityOptions = {},
): UseEntitiesResult<Row> {
  const { queryClient, live, awaiting } = useLiveData(`${service}.useEntities`);
  const joined = ids.map((id) => (typeof id === "string" ? id : "")).join("\u0000");
  const count = ids.length;
  const rowIds = useMemo(() => (count === 0 ? [] : joined.split("\u0000")), [joined, count]);
  const active = options.enabled !== false;
  useEffect(() => {
    const held = rowIds.filter((id) => id !== "");
    return active && held.length > 0 ? live.entities.subscribe(service, held) : undefined;
  }, [live, service, rowIds, active]);
  const view = useOverlayView(queryClient, service);
  const entries = useQueries({
    queries: rowIds.map((id) => entryQuery<EntityEntry<Row>>(entityKey(service, id))),
    combine: entriesOf<Row>,
  });
  // Disabled, or awaiting new credentials' hello, it shows nothing of what is cached.
  const held = active && !awaiting ? entries : NO_ENTRIES;
  return useMemo(() => combined(rowIds, held, view, active), [rowIds, held, view, active]);
}
