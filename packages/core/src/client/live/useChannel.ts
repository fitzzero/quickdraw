"use client";

// `qd.<service>.<channel>.useChannel()` (RFC 0003 section 12.5): fast
// one-way input such as cursors or typing. `send(payload)` emits `qd:ch
// [service, channel, payload]` volatile: when the connection is backed up
// the message is dropped rather than queued, which is what input superseded
// by the next message wants. There is no answer; the server drops a message
// over its rate, with an invalid payload or without access, silently. Ported
// from 4.1's `useChannelSend` (4.1 `src/client/useChannelSend.ts:36`).
//
// A host-served channel (`serve: "host"`) goes to the host of the room its
// `requires: { room }` names instead, over this connection's way to it
// (`../host/links.ts`): dropped while no way is open, as a message is when
// the connection is backed up.

import { useCallback, useMemo } from "react";
import { CLIENT_EVENTS } from "../../contract/names";
import { isHostServed, type ChannelDef } from "../../contract/realtime";
import { useConnectionState, useQuickdrawContext } from "../context";
import { hostsOf } from "../host/hosts";
import { hostLinksOf } from "../host/links";
import { channelRoomOf } from "../host/rooms";

/** What `useChannel` returns. */
export interface UseChannelResult<Payload> {
  /** Sends one message; does nothing while the socket is not connected. Stable across renders. */
  send(payload: Payload): void;
  /** True while the socket is connected and the server has said hello on it. */
  readonly isReady: boolean;
}

/** One channel of a service, as its member sends on it; `def` is the contract's, for a host-served one. */
export function useChannel<Payload>(
  service: string,
  channel: string,
  def?: ChannelDef,
): UseChannelResult<Payload> {
  const { connection } = useQuickdrawContext(`${service}.${channel}.useChannel`);
  const state = useConnectionState(connection);
  const send = useCallback(
    (payload: Payload) => {
      const { socket } = connection;
      if (!socket.connected) {
        return;
      }
      if (def !== undefined && isHostServed(def)) {
        const room = channelRoomOf(def, payload, hostsOf(connection).rooms.keys());
        if (room !== undefined) {
          hostLinksOf(connection).send(room, service, channel, payload);
        }
        return;
      }
      socket.volatile.emit(CLIENT_EVENTS.channel, [service, channel, payload]);
    },
    [connection, service, channel, def],
  );
  const isReady = state.status === "connected" && state.hello !== null;
  return useMemo(() => ({ send, isReady }), [send, isReady]);
}
