// Presence, streams, channels and typed room events for one dispatcher (RFC
// 0003 section 12.5), made with its live data (`emit/live.ts`): the socket
// listeners they add to every v5 socket, `ctx.rooms` and `ctx.presence` for
// each call, and the stream handles `qd.stream(contract, name)` returns.

import type { AnyContract } from "../../contract/defineContract";
import type { RoomOccupancy } from "../context";
import { onDisconnect } from "../emit/answer";
import type { Hub } from "../emit/hub";
import type { QuickdrawServerSocket, SocketContext } from "../transports/types";
import { channelMessages } from "./channels";
import { createPresence, PresenceRecords } from "./presence";
import { createRooms, unjoinable } from "./rooms";
import { createStreams, type Streams } from "./streams";
import type { ContextRooms, Presence, StreamHandle } from "./types";

export type { Presence, StreamHandle };

/** The realtime half of one dispatcher's live data. */
export interface Realtime {
  /** Serves `qd:ch`, `qd:stream:sub` and `qd:stream:unsub`, and leaves app rooms on disconnect. */
  extension(socket: QuickdrawServerSocket, context: SocketContext): void;
  /** `ctx.presence`, `dispatcher.presence` and `server.presence`. */
  readonly presence: Presence;
  /**
   * The `ctx.rooms` of a call: its socket's for a call over a v5 socket, else
   * one that joins nothing. For a method that shares its runs (`share`),
   * `join` and `leave` throw `INTERNAL`: a shared run serves several callers,
   * and would join or leave only the first one's socket.
   */
  roomsFor(transport: string, connectionId: string | undefined, share?: string): ContextRooms;
  /** The handle of a stream this dispatcher serves; a `TypeError` for any other. */
  stream(contract: AnyContract, name: string): StreamHandle<AnyContract, string>;
  /** The sockets in a room of the attached server, for the kits (`KitRuntime.occupancy`). */
  readonly occupancy: RoomOccupancy;
  /** Revokes stream subscriptions on access changes and changed grants. */
  readonly revocation: Streams["revocation"];
}

/** Creates the realtime half of a dispatcher's live data, on its hub. */
export function createRealtime(hub: Hub): Realtime {
  const records = new PresenceRecords();
  const presence = createPresence(hub, records);
  const rooms = createRooms({ hub, records });
  const streams = createStreams(hub);
  const channels = channelMessages({ hub, rooms, presence, warned: new WeakSet() });
  return Object.freeze({
    extension(socket: QuickdrawServerSocket, context: SocketContext): void {
      channels(socket);
      streams.extension(socket, context);
      onDisconnect(socket, context, () => {
        rooms.disconnected(socket);
      });
    },
    presence,
    roomsFor(transport: string, connectionId: string | undefined, share?: string): ContextRooms {
      const socket =
        transport === "socket" && connectionId !== undefined
          ? hub.io?.sockets.sockets.get(connectionId)
          : undefined;
      const own = socket === undefined ? rooms.detached : rooms.of(socket);
      return share === undefined ? own : unjoinable(own, share);
    },
    stream: (contract: AnyContract, name: string) => streams.handle(contract, name),
    occupancy: Object.freeze({
      sockets: (room: string) => hub.io?.sockets.adapter.rooms.get(room)?.size ?? 0,
      complete: () => hub.io === undefined || hub.probe.local(),
    }),
    revocation: streams.revocation,
  });
}
