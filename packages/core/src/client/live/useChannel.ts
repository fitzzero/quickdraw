"use client";

// `qd.<service>.<channel>.useChannel()` (RFC 0003 section 12.5): fast
// one-way input such as cursors or typing. `send(payload)` emits `qd:ch
// [service, channel, payload]` volatile: when the connection is backed up
// the message is dropped rather than queued, which is what input superseded
// by the next message wants. There is no answer; the server drops a message
// over its rate, with an invalid payload or without access, silently. Ported
// from 4.1's `useChannelSend` (`legacy-src/client/useChannelSend.ts:36`).

import { useCallback, useMemo } from "react";
import { CLIENT_EVENTS } from "../../contract/names";
import { useConnectionState, useQuickdrawContext } from "../context";

/** What `useChannel` returns. */
export interface UseChannelResult<Payload> {
  /** Sends one message; does nothing while the socket is not connected. Stable across renders. */
  send(payload: Payload): void;
  /** True while the socket is connected and the server has said hello on it. */
  readonly isReady: boolean;
}

/** One channel of a service, as its member sends on it. */
export function useChannel<Payload>(service: string, channel: string): UseChannelResult<Payload> {
  const { connection } = useQuickdrawContext(`${service}.${channel}.useChannel`);
  const state = useConnectionState(connection);
  const send = useCallback(
    (payload: Payload) => {
      const { socket } = connection;
      if (socket.connected) {
        socket.volatile.emit(CLIENT_EVENTS.channel, [service, channel, payload]);
      }
    },
    [connection, service, channel],
  );
  const isReady = state.status === "connected" && state.hello !== null;
  return useMemo(() => ({ send, isReady }), [send, isReady]);
}
