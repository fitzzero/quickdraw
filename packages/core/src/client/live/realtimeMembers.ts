"use client";

// The realtime members of `qd.<service>` (RFC 0003 section 12.5), built once
// per contract with the rest of the client (`members.ts`): one per stream
// (`useStream`), per channel (`useChannel`) and per event (`useEvent`). They
// sit beside the methods and collections, which share their namespace.

import type { AnyContract } from "../../contract/defineContract";
import { isScopedStream } from "../../contract/realtime";
import type { StreamTarget } from "./streams";
import { useChannel } from "./useChannel";
import { useEvent, type UseEventOptions } from "./useEvent";
import { useStream, type UseStreamOptions } from "./useStream";

/**
 * `qd.<service>.<stream>.useStream`: `(scope, options)` for a scoped stream,
 * `(options)` for a global one.
 */
function streamMember(target: StreamTarget): object {
  return Object.freeze({
    useStream: (first?: unknown, second?: UseStreamOptions) => {
      const scope = target.scoped ? (first as string | null | undefined) : undefined;
      const options = target.scoped ? second : (first as UseStreamOptions | undefined);
      return useStream(target, scope, options);
    },
  });
}

/** The stream, channel and event members of one contract's service, keyed as they sit on `qd.<service>`. */
export function realtimeMembers(contract: AnyContract): [string, object][] {
  const service = contract.name;
  const streams = Object.entries(contract.streams).map(([stream, def]): [string, object] => [
    stream,
    streamMember(Object.freeze({ service, stream, scoped: isScopedStream(def) })),
  ]);
  const channels = Object.keys(contract.channels).map((channel): [string, object] => [
    channel,
    Object.freeze({ useChannel: () => useChannel(service, channel) }),
  ]);
  const events = Object.keys(contract.events).map((event): [string, object] => [
    event,
    Object.freeze({
      useEvent: (handler: (payload: unknown) => void, options?: UseEventOptions) => {
        useEvent(service, event, handler, options);
      },
    }),
  ]);
  return [...streams, ...channels, ...events];
}
