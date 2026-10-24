"use client";

// `qd.<service>.<channel>.useChannel()` (RFC 0003 section 12.5): fast
// one-way input such as cursors or typing. `send(payload)` emits `qd:ch
// [service, channel, payload]`; while the way to the server is backed up
// (`../backlog.ts`: 64 packets, or more than 32 KiB, waiting) the message is
// dropped rather than queued, which is what input superseded by the next
// message wants. Never for a write in flight, as Socket.IO's volatile flag
// drops one: of the messages sent in one tick it kept only the first. There
// is no answer; the server drops a message over its rate, with an invalid
// payload or without access, silently. Ported from 4.1's `useChannelSend`
// (4.1 `src/client/useChannelSend.ts:36`).
//
// A message is dropped, too, until the socket's own `qd:hello` has arrived:
// a reconnect's socket may speak for someone else (a session cookie that
// changed meanwhile), and a channel that requires no room takes a message
// from any signed-in socket, so Ada's input would run as Ed. `isReady` reads
// false meanwhile, though a drop keeps the last hello (`../call.ts` holds
// calls the same way; a channel message is input the next one supersedes,
// so it is dropped rather than held).
//
// A host-served channel (`serve: "host"`) goes to the host of the room its
// `requires: { room }` names instead, over this connection's way to it
// (`../host/links.ts`): dropped while no way is open, as a message is when
// the connection is backed up.

import { useCallback, useMemo } from "react";
import { CLIENT_EVENTS } from "../../contract/names";
import { isHostServed, type ChannelDef } from "../../contract/realtime";
import { backedUp } from "../backlog";
import { callHoldOf, type QuickdrawConnection } from "../connection";
import { useConnectionState, useQuickdrawContext } from "../context";
import { hostsOf } from "../host/hosts";
import { hostLinksOf } from "../host/links";
import { channelRoomOf } from "../host/rooms";

/** What `useChannel` returns. */
export interface UseChannelResult<Payload> {
  /**
   * Sends one message; does nothing while the socket is not connected, or
   * its own hello has not arrived yet (a reconnect's socket may speak for
   * another user), or while the connection is backed up. Stable across
   * renders.
   */
  send(payload: Payload): void;
  /** True while the socket is connected and the server has said hello on that socket. */
  readonly isReady: boolean;
}

/** True while a message may go out on `connection`'s socket: connected, and its own hello in. */
function confirmedSocket(connection: QuickdrawConnection): boolean {
  return connection.socket.connected && callHoldOf(connection)?.confirmed !== false;
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
      // Until its own hello, whom the socket speaks for is not known: the message is dropped.
      if (!confirmedSocket(connection)) {
        return;
      }
      if (def !== undefined && isHostServed(def)) {
        const room = channelRoomOf(def, payload, hostsOf(connection).rooms.keys());
        if (room !== undefined) {
          hostLinksOf(connection).send(room, service, channel, payload);
        }
        return;
      }
      // Dropped, never queued, while the way to the server is backed up.
      if (backedUp(socket)) {
        return;
      }
      socket.emit(CLIENT_EVENTS.channel, [service, channel, payload]);
    },
    [connection, service, channel, def],
  );
  // The hello a drop keeps is the last socket's: ready once this one's own has arrived.
  const isReady =
    state.status === "connected" && state.hello !== null && confirmedSocket(connection);
  return useMemo(() => ({ send, isReady }), [send, isReady]);
}
