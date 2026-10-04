"use client";

// The parts of `qd.<service>.<method>.useQuery` beyond TanStack's own
// (RFC 0003 sections 11.3 and 11.4): joining the change topic the query
// watches (and holding its read until the join is answered), showing the
// overlays of optimistic mutations over the rows it returns, and showing
// nothing while new credentials await their hello.

import { hashKey, type QueryClient, type UseQueryResult } from "@tanstack/react-query";
import { useEffect, useMemo, useRef, useSyncExternalStore } from "react";
import { collectionTopic, SERVICE_TOPIC } from "../contract/names";
import type { QuickdrawConnection } from "./connection";
import type { InvalidationCoordinator } from "./coordinator";
import type { MethodQueryKey } from "./keys";
import type { MethodTarget } from "./members";
import { NO_OVERLAYS, overlaysOf, type OverlayView } from "./optimistic";
import { rowShapeOf, showRows } from "./overlayRows";
import { readAtOf } from "./versions";

/**
 * The change topic a query of `target` with `input` watches: the service's
 * own (`watch: "service"`), or `{collection}:{scope}`, with the scope from
 * the contract's `watch.scope(input)`. `undefined` when the method watches
 * nothing, or the scope function throws or returns no scope.
 */
export function topicOf(target: MethodTarget, input: unknown): string | undefined {
  const { watch } = target;
  if (watch === undefined) {
    return undefined;
  }
  if (watch === SERVICE_TOPIC) {
    return SERVICE_TOPIC;
  }
  let scope: unknown;
  try {
    scope = (watch.scope as (input: unknown) => unknown)(input);
  } catch {
    return undefined;
  }
  return typeof scope === "string" && scope !== ""
    ? collectionTopic(watch.collection, scope)
    : undefined;
}

/** What {@link useTopicWatch} watches, and how it invalidates. */
export interface QueryWatch {
  readonly connection: QuickdrawConnection;
  readonly coordinator: InvalidationCoordinator;
  readonly service: string;
  readonly queryKey: MethodQueryKey;
  /** The topic, or `undefined` to watch nothing. */
  readonly topic: string | undefined;
}

/** True when a read of the cached query `queryKey` was sent: it holds a result or an error, or is reading. */
function wasRead(coordinator: InvalidationCoordinator, queryKey: MethodQueryKey): boolean {
  const query = coordinator.queryClient.getQueryCache().find({ queryKey, exact: true });
  if (query === undefined) {
    return false;
  }
  const { dataUpdatedAt, errorUpdatedAt, fetchStatus } = query.state;
  return dataUpdatedAt > 0 || errorUpdatedAt > 0 || fetchStatus !== "idle";
}

/** Resolves when `joined` does, or as soon as `signal` aborts. */
function untilJoinedOrAborted(
  joined: Promise<void>,
  signal: AbortSignal | undefined,
): Promise<void> {
  if (signal === undefined) {
    return joined;
  }
  return new Promise<void>((resolve) => {
    const done = (): void => {
      signal.removeEventListener("abort", done);
      resolve();
    };
    if (signal.aborted) {
      done();
      return;
    }
    signal.addEventListener("abort", done, { once: true });
    void joined.then(done);
  });
}

/**
 * Holds a watching query's read while its change topic is being joined on a
 * connected socket, until the server answers the join (RFC 0003 section 17):
 * joined, the read then sees every change made before the join, so the
 * query is read once on its first mount, not once and again when the join
 * lands; refused, it reads anyway. Returns at once when there is nothing to
 * wait for, and as soon as `signal` aborts (the call then fails `CANCELLED`
 * without being sent).
 */
export async function readAfterJoin(
  connection: QuickdrawConnection,
  service: string,
  topic: string | undefined,
  queryKey: MethodQueryKey,
  signal: AbortSignal | undefined,
): Promise<void> {
  const joined =
    topic === undefined
      ? undefined
      : connection.waitForJoin({ service, topic, key: hashKey(queryKey) });
  if (joined !== undefined) {
    await untilJoinedOrAborted(joined, signal);
  }
}

/**
 * Joins the change topic of a watching query while the component is
 * mounted, and invalidates the query through the coordinator on each
 * `qd:changed`. Components reading the same query cause one invalidation per
 * frame between them: their watches share the query key's hash. A read that
 * starts while the join is in flight waits for it (`readAfterJoin`). When
 * the server acknowledges the join after a read of the query was sent
 * instead (on a socket that was not connected yet, a result prefetched
 * before the watch, or a read that waited in the send buffer through an
 * outage and went out before the topic was joined again), a change made
 * between that read and the join sent no `qd:changed` here, so the query is
 * invalidated once (RFC 0003 section 17).
 */
export function useTopicWatch({
  connection,
  coordinator,
  service,
  queryKey,
  topic,
}: QueryWatch): void {
  const latest = useRef(queryKey);
  useEffect(() => {
    latest.current = queryKey;
  });
  const key = hashKey(queryKey);
  useEffect(() => {
    if (topic === undefined) {
      return undefined;
    }
    return connection.watch({
      service,
      topic,
      key,
      onChanged: () => {
        coordinator.invalidate(latest.current, { exact: true });
      },
      onJoined: () => {
        if (wasRead(coordinator, latest.current)) {
          coordinator.invalidate(latest.current, { exact: true });
        }
      },
    });
  }, [connection, coordinator, service, topic, key]);
}

const ignoreChanges = (): (() => void) => () => undefined;

const noOverlays = (): OverlayView => NO_OVERLAYS;

/**
 * The `select` a query of `target` runs: the overlays of optimistic
 * mutations shown over the rows it returns, then the caller's own `select`.
 * It changes when an overlay of the service does, which makes TanStack run it
 * again. `select` itself for a method whose output holds no rows.
 */
export function useOverlaySelect<Output, Data>(
  queryClient: QueryClient,
  target: MethodTarget,
  select: ((data: Output) => Data) | undefined,
): ((data: Output) => Data) | undefined {
  const overlays = overlaysOf(queryClient);
  const shape = rowShapeOf(target.output);
  const { service } = target;
  const snapshot = (): OverlayView => (shape === undefined ? NO_OVERLAYS : overlays.view(service));
  // No mutation runs on a server: its render, and the hydration, show none.
  const view = useSyncExternalStore(
    shape === undefined ? ignoreChanges : overlays.subscribe,
    snapshot,
    noOverlays,
  );
  return useMemo(() => {
    if (shape === undefined) {
      return select;
    }
    return (data: Output): Data => {
      const shown = showRows(view, shape, data, readAtOf(data));
      return select === undefined ? (shown as unknown as Data) : select(shown);
    };
  }, [shape, view, select]);
}

/**
 * `result` as a query that has read nothing yet: what `useQuery` shows while
 * new credentials await their hello (`./session.ts`), since what is cached
 * may be the last user's. The cache keeps it; the hello decides.
 */
export function hiddenResult<Data, Failure>(
  result: UseQueryResult<Data, Failure>,
): UseQueryResult<Data, Failure> {
  return {
    ...result,
    data: undefined,
    error: null,
    status: "pending",
    isPending: true,
    isSuccess: false,
    isError: false,
    isLoading: result.isFetching,
    isLoadingError: false,
    isRefetchError: false,
    isRefetching: false,
    isPlaceholderData: false,
    isFetched: false,
    isFetchedAfterMount: false,
    dataUpdatedAt: 0,
    errorUpdatedAt: 0,
    failureCount: 0,
    failureReason: null,
    errorUpdateCount: 0,
  } as UseQueryResult<Data, Failure>;
}
