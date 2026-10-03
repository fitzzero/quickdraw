"use client";

// The parts of `qd.<service>.<method>.useQuery` beyond TanStack's own
// (RFC 0003 sections 11.3 and 11.4): joining the change topic the query
// watches, and showing the overlays of optimistic mutations over the rows it
// returns.

import { hashKey, type QueryClient } from "@tanstack/react-query";
import { useEffect, useMemo, useRef, useSyncExternalStore } from "react";
import { collectionTopic } from "../contract/names";
import type { QuickdrawConnection } from "./connection";
import type { InvalidationCoordinator } from "./coordinator";
import type { MethodQueryKey } from "./keys";
import type { MethodTarget } from "./members";
import { overlaysOf, rowShapeOf, showRows, type OverlayView } from "./optimistic";

/**
 * The change topic a query of `target` with `input` watches:
 * `{collection}:{scope}`, with the scope from the contract's
 * `watch.scope(input)`. `undefined` when the method watches nothing, or the
 * scope function throws or returns no scope.
 */
export function topicOf(target: MethodTarget, input: unknown): string | undefined {
  const { watch } = target;
  if (watch === undefined) {
    return undefined;
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

/**
 * Joins the change topic of a watching query while the component is
 * mounted, and invalidates the query through the coordinator on each
 * `qd:changed`. Components reading the same query cause one invalidation per
 * frame between them: their watches share the query key's hash.
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
    });
  }, [connection, coordinator, service, topic, key]);
}

const ignoreChanges = (): (() => void) => () => undefined;

const NO_VIEW: OverlayView = Object.freeze({ apply: <T>(row: T) => row });

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
  const snapshot = (): OverlayView => (shape === undefined ? NO_VIEW : overlays.view(service));
  const view = useSyncExternalStore(
    shape === undefined ? ignoreChanges : overlays.subscribe,
    snapshot,
    snapshot,
  );
  return useMemo(() => {
    if (shape === undefined) {
      return select;
    }
    return (data: Output): Data => {
      const shown = showRows(view, shape, data);
      return select === undefined ? (shown as unknown as Data) : select(shown);
    };
  }, [shape, view, select]);
}
