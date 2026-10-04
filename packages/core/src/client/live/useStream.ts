"use client";

// `qd.<service>.<stream>.useStream(scope, { max })` (RFC 0003 section 12.5):
// a feed that starts with recent history and then appends, such as logs or
// metrics. The first answer is the server's seed (the latest items it kept
// for the scope), then every item pushed after it arrives in order; the hook
// shows the latest `max` (default 500). A global stream takes no scope:
// `useStream({ max })`. Two components holding one feed share one
// subscription (`streams.ts`).

import { useCallback, useEffect, useMemo, useSyncExternalStore } from "react";
import type { QuickdrawError } from "../../protocol/errors";
import { useLiveData } from "./liveHooks";
import {
  feedKey,
  PENDING_STREAM,
  streamMaxOf,
  type StreamState,
  type StreamTarget,
} from "./streams";

/** Options of `useStream`. */
export interface UseStreamOptions {
  /** How many of the latest items to show. Default 500; at most 10,000. */
  readonly max?: number;
  /** `false` holds no subscription and shows nothing. Default `true`. */
  readonly enabled?: boolean;
}

/** What `useStream` returns. */
export interface UseStreamResult<Item> {
  /** The latest items, oldest first: the seed, then what was pushed after it. */
  readonly items: readonly Item[];
  /** True until the server answers the subscribe with the seed. */
  readonly isLoading: boolean;
  /** Why the subscribe was refused: `FORBIDDEN` for a feed the user may not read. */
  readonly error: QuickdrawError | null;
}

const IDLE: StreamState = Object.freeze({
  items: Object.freeze([]),
  isLoading: false,
  error: null,
});

/**
 * One feed of a stream, live. `scope` is the scope of a scoped stream (a
 * `null` or empty one holds nothing) and `undefined` for a global stream.
 */
export function useStream<Item>(
  target: StreamTarget,
  scope: string | null | undefined,
  options: UseStreamOptions = {},
): UseStreamResult<Item> {
  const { live, awaiting } = useLiveData(`${target.service}.${target.stream}.useStream`);
  const feed = target.scoped ? (typeof scope === "string" ? scope : "") : undefined;
  const active = options.enabled !== false && feed !== "";
  const max = streamMaxOf(options.max);
  const key = feedKey(target.service, target.stream, feed);
  useEffect(
    () => (active ? live.streams.hold(target, feed, max) : undefined),
    [live, target, feed, max, active],
  );
  const listen = useCallback(
    (listener: () => void) => live.streams.listen(key, listener),
    [live, key],
  );
  // Awaiting new credentials' hello, it shows none of the last user's items.
  const read = (): StreamState =>
    active ? (awaiting ? PENDING_STREAM : live.streams.state(key)) : IDLE;
  // A server holds no feed: loading, as the browser hydrates it too.
  const onServer = (): StreamState => (active ? PENDING_STREAM : IDLE);
  const state = useSyncExternalStore(listen, read, onServer);
  return useMemo(() => {
    const items =
      state.items.length > max ? state.items.slice(state.items.length - max) : state.items;
    return { items: items as readonly Item[], isLoading: state.isLoading, error: state.error };
  }, [state, max]);
}
