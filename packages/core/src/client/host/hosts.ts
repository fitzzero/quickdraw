// The hosts of the app rooms a connection's socket is in (host mode, RFC
// 0003 section 12.5): the server's `qd:host [room, host]` frames, read by
// one listener per connection, made on first use (the live data makes it
// when a provider mounts, before its socket connects). A room's host is
// forgotten when the socket leaves the room (`qd:presence` with
// `users: []`) or disconnects: a new socket is in no room, and hears each
// room's host again as it joins.
//
// React-free.

import { SERVER_EVENTS } from "../../contract/names";
import { isRecord } from "../../protocol/guards";
import { isRoomName, isSocketId } from "../../protocol/peer";
import type { QuickdrawConnection } from "../connection";
import { notifyEach } from "../watch";

/** Hears a room's host change: its socket id, or `null` when the room has none now. */
export type HostListener = (room: string, host: string | null) => void;

/** The hosts of one connection's rooms. */
export interface HostDirectory {
  /** The host of `room`, when the socket is in it and it has one. */
  of(room: string): string | undefined;
  /** The rooms whose host is known, with it. */
  readonly rooms: ReadonlyMap<string, string>;
  /** Calls `listener` on each change; returns its removal. */
  listen(listener: HostListener): () => void;
}

function createDirectory(connection: QuickdrawConnection): HostDirectory {
  const rooms = new Map<string, string>();
  const listeners = new Set<HostListener>();
  const set = (room: string, host: string | null): void => {
    if ((rooms.get(room) ?? null) === host) {
      return;
    }
    if (host === null) {
      rooms.delete(room);
    } else {
      rooms.set(room, host);
    }
    notifyEach(listeners, (listener) => {
      listener(room, host);
    });
  };
  const { socket } = connection;
  socket.on(SERVER_EVENTS.host, (frame: unknown) => {
    const [room, host] = Array.isArray(frame) ? (frame as readonly unknown[]) : [];
    if (isRoomName(room) && (host === null || isSocketId(host))) {
      set(room, host);
    }
  });
  socket.on(SERVER_EVENTS.presence, (frame: unknown) => {
    // `{ room, users: [] }`: this socket left the room.
    if (
      isRecord(frame) &&
      isRoomName(frame.room) &&
      Array.isArray(frame.users) &&
      frame.users.length === 0
    ) {
      set(frame.room, null);
    }
  });
  socket.on("disconnect", () => {
    for (const room of [...rooms.keys()]) {
      set(room, null);
    }
  });
  return Object.freeze({
    of: (room: string) => rooms.get(room),
    rooms,
    listen(listener: HostListener): () => void {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
  });
}

const directories = new WeakMap<QuickdrawConnection, HostDirectory>();

/** The hosts of `connection`'s rooms, made on first use. */
export function hostsOf(connection: QuickdrawConnection): HostDirectory {
  let directory = directories.get(connection);
  if (directory === undefined) {
    directory = createDirectory(connection);
    directories.set(connection, directory);
  }
  return directory;
}

/**
 * The host of app room `room` (host mode): the socket id the server named
 * in `qd:host`, or `null` when the room has none or this connection's
 * socket is not in it. Without React, call it (or `onHostChange`) before
 * the joining call, so the connection hears the room's host as it joins.
 */
export function hostOf(connection: QuickdrawConnection, room: string): string | null {
  return hostsOf(connection).of(room) ?? null;
}

/**
 * Calls `listener(room, host)` whenever the host of a room this
 * connection's socket is in changes (`null`: none now, or the socket left
 * the room or disconnected); returns its removal.
 */
export function onHostChange(connection: QuickdrawConnection, listener: HostListener): () => void {
  return hostsOf(connection).listen(listener);
}
