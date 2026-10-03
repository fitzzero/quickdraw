// The stream, channel and event members of a mock client (`mockClient.ts`,
// RFC 0003 section 12.5), with no socket behind them:
//
// - a stream's `useStream` shows what the test set with `mockItems` (the
//   latest `max` of them) or `mockError`; a feed nobody set is loading;
// - a channel's `useChannel` is always ready, and its `send` records each
//   payload in the member's `sent`;
// - an event's `useEvent` registers its handler, and `mockEmit(payload)`
//   calls every mounted one (wrap it in Testing Library's `act`).
//
// What the test set is forgotten with the rest of the mock (`$reset`, or
// after each test).

import { useEffect, useRef, useSyncExternalStore } from "react";
import { streamMaxOf, type StreamState } from "../client/live/streams";
import type { UseEventOptions } from "../client/live/useEvent";
import type { UseStreamOptions, UseStreamResult } from "../client/live/useStream";
import type { AnyContract } from "../contract/defineContract";
import { isScopedStream } from "../contract/realtime";
import type { QuickdrawError } from "../protocol/errors";
import type { MockStore } from "./mockLive";

/** One feed as the test set it: its items, or why it failed. */
type FeedState = { readonly items: readonly unknown[] } | { readonly error: QuickdrawError };

function keyOf(...parts: readonly string[]): string {
  return parts.join("\u0000");
}

/** What `useStream` shows of a mocked feed. */
function feedResult(state: unknown, active: boolean, max: number): StreamState {
  if (!active || state === undefined) {
    return { items: [], isLoading: active, error: null };
  }
  const feed = state as FeedState;
  if ("error" in feed) {
    return { items: [], isLoading: false, error: feed.error };
  }
  const items = feed.items.length > max ? feed.items.slice(feed.items.length - max) : feed.items;
  return { items, isLoading: false, error: null };
}

/** `qd.<service>.<stream>` of a mock client. */
function mockStreamMember(
  store: MockStore,
  service: string,
  stream: string,
  scoped: boolean,
): object {
  const feedKey = (scope: unknown): string =>
    keyOf("stream", service, stream, scoped && typeof scope === "string" ? scope : "");
  const useMockStream = (first?: unknown, second?: UseStreamOptions): UseStreamResult<unknown> => {
    const scope = scoped ? first : undefined;
    const options = (scoped ? second : (first as UseStreamOptions | undefined)) ?? {};
    const active =
      options.enabled !== false && (!scoped || (typeof scope === "string" && scope !== ""));
    const max = streamMaxOf(options.max);
    const read = (): StreamState =>
      store.read(keyOf("view", feedKey(scope), String(active), String(max)), () =>
        feedResult(store.value(feedKey(scope)), active, max),
      );
    return useSyncExternalStore(store.subscribe, read, read);
  };
  // `(scope, value)` for a scoped stream, `(value)` for a global one.
  const set = (args: readonly unknown[], value: (last: unknown) => FeedState): void => {
    store.setValue(feedKey(scoped ? args[0] : undefined), value(args.at(-1)));
  };
  return Object.freeze({
    useStream: useMockStream,
    mockItems: (...args: unknown[]) => {
      set(args, (items) => ({ items: [...(items as readonly unknown[])] }));
    },
    mockError: (...args: unknown[]) => {
      set(args, (error) => ({ error: error as QuickdrawError }));
    },
  });
}

/** `qd.<service>.<channel>` of a mock client. */
function mockChannelMember(store: MockStore, service: string, channel: string): object {
  const sentKey = keyOf("sent", service, channel);
  const sent = (): readonly unknown[] =>
    (store.value(sentKey) as readonly unknown[] | undefined) ?? [];
  const result = Object.freeze({
    send: (payload: unknown) => {
      store.setValue(sentKey, [...sent(), payload]);
    },
    isReady: true,
  });
  return Object.freeze(
    Object.defineProperties(
      { useChannel: () => result },
      { sent: { get: () => [...sent()], enumerable: true } },
    ),
  );
}

/** `qd.<service>.<event>` of a mock client. */
function mockEventMember(): object {
  const handlers = new Set<(payload: unknown) => void>();
  return Object.freeze({
    useEvent: (handler: (payload: unknown) => void, options: UseEventOptions = {}) => {
      const latest = useRef(handler);
      useEffect(() => {
        latest.current = handler;
      });
      const enabled = options.enabled !== false;
      useEffect(() => {
        if (!enabled) {
          return undefined;
        }
        const entry = (payload: unknown): void => {
          latest.current(payload);
        };
        handlers.add(entry);
        return () => {
          handlers.delete(entry);
        };
      }, [enabled]);
    },
    mockEmit: (payload: unknown) => {
      for (const handler of [...handlers]) {
        handler(payload);
      }
    },
  });
}

/** The stream, channel and event members of one contract's service on a mock client. */
export function mockRealtimeMembers(store: MockStore, contract: AnyContract): [string, object][] {
  const service = contract.name;
  return [
    ...Object.entries(contract.streams).map(([stream, def]): [string, object] => [
      stream,
      mockStreamMember(store, service, stream, isScopedStream(def)),
    ]),
    ...Object.keys(contract.channels).map((channel): [string, object] => [
      channel,
      mockChannelMember(store, service, channel),
    ]),
    ...Object.keys(contract.events).map((event): [string, object] => [event, mockEventMember()]),
  ];
}
