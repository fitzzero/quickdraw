// `holdStream(store, target, listener)` (RFC 0003 sections 11.5 and 12.5):
// one feed of a contract's stream, held in a script's live store
// (`liveStore.ts`) and shown as `useStream` shows it: the server's seed
// (its latest items for the scope), then every item pushed after it, oldest
// first, the latest `max` (default 500) kept. A host-served stream's feed
// is served by the host of the scope's room, as for the hook. See
// `holding.ts` for when the listener is called.
//
// React-free, and TanStack-free.

import type { AnyContract } from "../../contract/defineContract";
import type { IsScopedStream, StreamItemOf, StreamName } from "../../contract/infer";
import { isHostServed, isScopedStream } from "../../contract/realtime";
import { awaitingHelloOf } from "../cacheSession";
import { streamRoomOf } from "../host/rooms";
import { holdingOf, type Holding, type StreamSnapshot } from "./holding";
import { liveCacheOf, type LiveStore } from "./liveStore";
import {
  PENDING_STREAM,
  feedKey,
  streamMaxOf,
  type StreamState,
  type StreamTarget,
} from "./streams";

/**
 * What `holdStream` holds: one feed of a contract's stream, a scope's for a
 * scoped stream (`scope` required) and the stream's for a global one (no
 * `scope`).
 */
export type HoldStreamTarget<C extends AnyContract, K extends StreamName<C>> = {
  readonly contract: C;
  readonly stream: K;
  /** How many of the latest items to show. Default 500; at most 10,000. */
  readonly max?: number;
} & (IsScopedStream<C, K> extends true
  ? { /** The scope's feed: a non-empty string. */ readonly scope: string }
  : { readonly scope?: undefined });

/**
 * Holds a feed of `target.stream` in `store`, and calls `listener` with what
 * it shows as that changes. Throws a `TypeError` for a stream the contract
 * does not declare, or a scope a scoped stream needs and does not get (or a
 * global stream gets).
 *
 * @example
 * const logs = holdStream(live, { contract: build, stream: "logs", scope: buildId }, (feed) => {
 *   for (const line of feed.items) process.stdout.write(`${line.text}\n`);
 * });
 */
export function holdStream<C extends AnyContract, K extends StreamName<C>>(
  store: LiveStore,
  target: HoldStreamTarget<C, K>,
  listener: (snapshot: StreamSnapshot<StreamItemOf<C, K>>) => void,
): Holding<StreamSnapshot<StreamItemOf<C, K>>> {
  const { contract, stream } = target;
  const scope: unknown = target.scope;
  const def = Object.hasOwn(contract.streams, stream) ? contract.streams[stream] : undefined;
  if (def === undefined) {
    throw new TypeError(`holdStream: ${contract.name} declares no stream ${stream}`);
  }
  const scoped = isScopedStream(def);
  if (scoped ? typeof scope !== "string" || scope === "" : scope !== undefined) {
    throw new TypeError(
      scoped
        ? `holdStream: ${stream} is a scoped stream: scope must be a non-empty string`
        : `holdStream: ${stream} is a global stream: it takes no scope`,
    );
  }
  const feed = scoped ? (scope as string) : undefined;
  const cache = liveCacheOf(store);
  const { connection } = store;
  const max = streamMaxOf(target.max);
  const key = feedKey(contract.name, stream, feed);
  let last: { readonly state: StreamState; readonly snapshot: StreamSnapshot<unknown> } | undefined;
  const read = (): StreamSnapshot<unknown> => {
    // Awaiting new credentials' hello, it shows none of the last user's items.
    const state = awaitingHelloOf(connection, cache) ? PENDING_STREAM : store.streams.state(key);
    if (last?.state === state) {
      return last.snapshot;
    }
    const items =
      state.items.length > max ? state.items.slice(state.items.length - max) : state.items;
    const snapshot = Object.freeze({ items, isLoading: state.isLoading, error: state.error });
    last = { state, snapshot };
    return snapshot;
  };
  // A host-served stream's feed is served by the host of the scope's room.
  const host = isHostServed(def) ? { host: (room: string) => streamRoomOf(def, room) } : {};
  const live: StreamTarget = { service: contract.name, stream, scoped, ...host };
  const release = store.streams.hold(live, feed, max);
  return holdingOf(
    read,
    (changed) => {
      const stopFeed = store.streams.listen(key, changed);
      const stopHellos = connection.subscribe(changed);
      return () => {
        stopFeed();
        stopHellos();
      };
    },
    release,
    listener as (snapshot: StreamSnapshot<unknown>) => void,
  ) as Holding<StreamSnapshot<StreamItemOf<C, K>>>;
}
