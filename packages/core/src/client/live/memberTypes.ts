// The types of the live members of `qd.<service>` that `clientTypes.ts`
// puts beside its methods: the entity and collection hooks' types, and the
// realtime members (RFC 0003 section 12.5), one per stream, channel and
// event of the contract, typed from it.

import type { AnyContract } from "../../contract/defineContract";
import type {
  ChannelInputOf,
  ChannelName,
  EventName,
  EventPayloadOf,
  IsScopedStream,
  StreamItemOf,
  StreamName,
} from "../../contract/infer";
import type { UseChannelResult } from "./useChannel";
import type { UseEventOptions } from "./useEvent";
import type { UseStreamOptions, UseStreamResult } from "./useStream";

export type { UseCollectionOptions, UseCollectionResult } from "./useCollection";
export type { UseEntitiesResult, UseEntityOptions, UseEntityResult } from "./useEntity";

/** `qd.<key>.<stream>` for a stream with one feed per scope. */
export interface ScopedStreamMember<C extends AnyContract, K extends StreamName<C>> {
  /**
   * One scope's feed, live: the server's seed (its latest items), then every
   * item pushed after it, oldest first, the latest `max` (default 500) kept.
   * A `null` or empty scope holds nothing.
   */
  useStream(
    scope: string | null | undefined,
    options?: UseStreamOptions,
  ): UseStreamResult<StreamItemOf<C, K>>;
}

/** `qd.<key>.<stream>` for a stream with one feed for the whole service. */
export interface GlobalStreamMember<C extends AnyContract, K extends StreamName<C>> {
  /** The stream's feed, live: the server's seed, then every item pushed after it. */
  useStream(options?: UseStreamOptions): UseStreamResult<StreamItemOf<C, K>>;
}

/** `qd.<key>.<stream>`: scoped or global, as the contract declares the stream. */
export type StreamMember<C extends AnyContract, K extends StreamName<C>> =
  IsScopedStream<C, K> extends true ? ScopedStreamMember<C, K> : GlobalStreamMember<C, K>;

/** `qd.<key>.<channel>`. */
export interface ChannelMember<C extends AnyContract, K extends ChannelName<C>> {
  /** Sends on the channel, volatile and unanswered: `{ send, isReady }`. */
  useChannel(): UseChannelResult<ChannelInputOf<C, K>>;
}

/** `qd.<key>.<event>`. */
export interface EventMember<C extends AnyContract, K extends EventName<C>> {
  /** Calls `handler` with the payload of each of these events the socket receives. */
  useEvent(handler: (payload: EventPayloadOf<C, K>) => void, options?: UseEventOptions): void;
}

/** One member per stream, channel and event of the contract, beside its methods and collections. */
export type RealtimeMembers<C extends AnyContract> = {
  readonly [K in StreamName<C>]: StreamMember<C, K>;
} & { readonly [K in ChannelName<C>]: ChannelMember<C, K> } & {
  readonly [K in EventName<C>]: EventMember<C, K>;
};
