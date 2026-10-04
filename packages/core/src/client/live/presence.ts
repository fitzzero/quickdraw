// Who is in the app rooms this connection's socket is in (RFC 0003 section
// 12.5), kept from the server's `qd:presence` frames: the list a socket gets
// as a method joins it to a room (`ctx.rooms.join`), then each user who
// joins or leaves. A room's users are a set of user ids: a repeated `joined`
// changes nothing. Leaving a room (`users: []`) or losing the socket (a
// disconnect leaves every room) forgets it; the app joins again, through its
// method, once reconnected.
//
// React-free: the live data (`liveData.ts`) makes one per connection and
// `QueryClient`, before the socket connects, so no frame is missed.

import { isName, isRecord } from "../../protocol/guards";
import { notifyEach } from "../watch";

/** The users in each app room the socket is in. */
export interface PresenceStore {
  /** The ids of the users in `room`, as the server last said; empty for a room the socket is not in. The same array until it changes. */
  users(room: string): readonly string[];
  /** Calls `listener` whenever the users of `room` change; returns the unsubscribe function. */
  listen(room: string, listener: () => void): () => void;
  /** A `qd:presence` frame arrived. */
  receive(frame: unknown): void;
  /** The socket disconnected, and with it left every room. */
  clear(): void;
}

const NOBODY: readonly string[] = Object.freeze([]);

function userList(value: unknown): readonly string[] | undefined {
  return Array.isArray(value) && value.every(isName)
    ? Object.freeze([...new Set(value as readonly string[])])
    : undefined;
}

/** The room's users after `frame`, or `undefined` for a frame that changes nothing. */
function next(
  current: readonly string[],
  frame: Readonly<Record<string, unknown>>,
): readonly string[] | undefined {
  const users = userList(frame.users);
  if (users !== undefined) {
    return users;
  }
  if (isName(frame.joined) && !current.includes(frame.joined)) {
    return Object.freeze([...current, frame.joined]);
  }
  if (isName(frame.left) && current.includes(frame.left)) {
    return Object.freeze(current.filter((user) => user !== frame.left));
  }
  return undefined;
}

/** Creates the presence of one connection's socket. */
export function createPresenceStore(): PresenceStore {
  const rooms = new Map<string, readonly string[]>();
  const listeners = new Map<string, Set<() => void>>();
  const changed = (room: string): void => {
    notifyEach(listeners.get(room) ?? [], (listener) => {
      listener();
    });
  };
  return Object.freeze({
    users: (room: string) => rooms.get(room) ?? NOBODY,
    listen(room: string, listener: () => void): () => void {
      const set = listeners.get(room) ?? new Set<() => void>();
      listeners.set(room, set);
      set.add(listener);
      return () => {
        set.delete(listener);
        if (set.size === 0 && listeners.get(room) === set) {
          listeners.delete(room);
        }
      };
    },
    receive(frame: unknown): void {
      if (!isRecord(frame) || !isName(frame.room)) {
        return;
      }
      const users = next(rooms.get(frame.room) ?? NOBODY, frame);
      if (users === undefined) {
        return;
      }
      if (users.length === 0) {
        rooms.delete(frame.room);
      } else {
        rooms.set(frame.room, users);
      }
      changed(frame.room);
    },
    clear(): void {
      const held = [...rooms.keys()];
      rooms.clear();
      for (const room of held) {
        changed(room);
      }
    },
  });
}
