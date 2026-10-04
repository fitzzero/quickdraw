"use client";

import * as React from "react";
import { channelEventName } from "../shared/types";
import { useQuickdrawSocket } from "./QuickdrawProvider";
import type { UseChannelSendResult } from "./types";

/**
 * Hook for sending fire-and-forget channel messages (the high-frequency
 * counterpart to useService).
 *
 * Channel messages are emitted volatile: if the connection is backpressured,
 * the message is dropped instead of queued — the right behavior for input
 * streams where the next message supersedes the last. There is no ack and no
 * response; the server validates, rate-limits (per-channel token bucket), and
 * access-checks each message, silently dropping any that fail.
 *
 * Receiving server broadcasts needs nothing new: volatile room emits arrive
 * as ordinary events, so pair this with `useRoomEvents` (and `useSubscription`
 * for room membership).
 *
 * @typeParam TPayload - The channel payload type (from the service's channel map)
 *
 * @example
 * ```tsx
 * function GameInput({ worldId }: { worldId: string }) {
 *   // Room membership (ACL-checked server-side) gates the channel
 *   useSubscription("gameService", worldId);
 *   const { send, isReady } = useChannelSend<GameInput>("gameService", "input");
 *
 *   // e.g. called from a 20Hz game loop
 *   const onTick = (input: GameInput) => send(input);
 * }
 * ```
 */
export function useChannelSend<TPayload = unknown>(
  serviceName: string,
  channelName: string,
): UseChannelSendResult<TPayload> {
  const { socket, isConnected } = useQuickdrawSocket();

  const eventName = channelEventName(serviceName, channelName);

  const send = React.useCallback(
    (payload: TPayload) => {
      if (!socket?.connected) return;
      socket.volatile.emit(eventName, payload);
    },
    [socket, eventName],
  );

  return { send, isReady: isConnected && !!socket };
}
