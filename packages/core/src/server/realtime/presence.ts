// Presence (RFC 0003 section 12.5): who is online, when they were last seen,
// and who is in a room. 4.1 apps read `io.sockets` themselves for this.
//
// This process keeps, for every app room a method joined with
// `ctx.rooms.join`, how many sockets of each user are in it (so a join and a
// leave know at once whether they change who is there), and the time each
// user's last socket disconnected. Both are bounded: a socket is in at most
// `MAX_APP_ROOMS` app rooms, and the last-seen times are kept for the
// `PRESENCE_MAX_LAST_SEEN` users seen last. Both live in `Map`s, so a user id
// or room named `__proto__` is an ordinary key.
//
// The answers come from this process's rooms while the server runs the
// in-memory adapter it was created with. Behind a cluster adapter (Redis)
// other nodes' sockets are not visible here, so `isOnline`, `count` and
// `users` ask every node through `io.in(room).fetchSockets()`; `lastSeen`
// still knows only this process's disconnects.

import { userRoom } from "../../contract/names";
import type { Hub } from "../emit/hub";
import type { QuickdrawIo } from "../transports/types";
import type { Presence } from "./types";

/** How many users' last-seen times one process keeps; the least recently seen go first. */
export const PRESENCE_MAX_LAST_SEEN = 100_000;

/** The most app rooms (`ctx.rooms.join`) one socket may be in at once. */
export const MAX_APP_ROOMS = 100;

/** This process's app-room occupancy by user, and its users' last-seen times. */
export class PresenceRecords {
  /** Per app room, how many sockets of each user are in it. */
  readonly #rooms = new Map<string, Map<string, number>>();
  /** When each user's last socket disconnected, oldest first. */
  readonly #lastSeen = new Map<string, number>();

  /** A socket of `userId` entered `room`; true when it is the user's first socket there. */
  entered(room: string, userId: string): boolean {
    const users = this.#rooms.get(room) ?? new Map<string, number>();
    this.#rooms.set(room, users);
    const sockets = (users.get(userId) ?? 0) + 1;
    users.set(userId, sockets);
    return sockets === 1;
  }

  /** A socket of `userId` left `room`; true when it was the user's last socket there. */
  exited(room: string, userId: string): boolean {
    const users = this.#rooms.get(room);
    const sockets = users?.get(userId);
    if (users === undefined || sockets === undefined) {
      return false;
    }
    if (sockets > 1) {
      users.set(userId, sockets - 1);
      return false;
    }
    users.delete(userId);
    if (users.size === 0) {
      this.#rooms.delete(room);
    }
    return true;
  }

  /** The users with a socket of this process in app room `room`, or `undefined` for a room no user joined here. */
  users(room: string): string[] | undefined {
    const users = this.#rooms.get(room);
    return users === undefined ? undefined : [...users.keys()];
  }

  /** The user's last socket disconnected at `at`. */
  seen(userId: string, at: number): void {
    this.#lastSeen.delete(userId);
    this.#lastSeen.set(userId, at);
    if (this.#lastSeen.size > PRESENCE_MAX_LAST_SEEN) {
      const oldest = this.#lastSeen.keys().next();
      if (oldest.done !== true) {
        this.#lastSeen.delete(oldest.value);
      }
    }
  }

  /** When the user's last socket here disconnected, or `undefined`. */
  lastSeen(userId: string): number | undefined {
    return this.#lastSeen.get(userId);
  }
}

/** The distinct user ids of these principals, in order; anonymous sockets have none. */
function distinctUsers(
  principals: Iterable<{ readonly userId?: unknown } | null | undefined>,
): string[] {
  const users = new Set<string>();
  for (const principal of principals) {
    const userId = principal?.userId;
    if (typeof userId === "string" && userId !== "") {
      users.add(userId);
    }
  }
  return [...users];
}

/** The users of this process's sockets in `room`, read from the app-room records or the adapter's rooms. */
function localUsers(io: QuickdrawIo, records: PresenceRecords, room: string): string[] {
  const tracked = records.users(room);
  if (tracked !== undefined) {
    return tracked;
  }
  const socketIds = io.sockets.adapter.rooms.get(room) ?? [];
  return distinctUsers(
    [...socketIds].map((socketId) => io.sockets.sockets.get(socketId)?.data.principal),
  );
}

/** The users with a socket in `room` on any node: through every node's sockets behind a cluster adapter. */
export async function usersInRoom(
  hub: Hub,
  records: PresenceRecords,
  room: string,
): Promise<string[]> {
  const { io } = hub;
  if (io === undefined) {
    return [];
  }
  if (hub.probe.local()) {
    return localUsers(io, records, room);
  }
  const sockets = await io.in(room).fetchSockets();
  return distinctUsers(sockets.map((socket) => socket.data.principal));
}

/** True while some socket of `userId` is in `room`, on any node. */
export async function inRoom(
  hub: Hub,
  records: PresenceRecords,
  room: string,
  userId: string,
): Promise<boolean> {
  return (await usersInRoom(hub, records, room)).includes(userId);
}

function checkName(member: string, value: unknown): asserts value is string {
  if (typeof value !== "string" || value === "") {
    throw new TypeError(`presence.${member}: pass a non-empty string`);
  }
}

/** The presence API of one dispatcher, answered from its server's sockets (none before a server attaches). */
export function createPresence(hub: Hub, records: PresenceRecords): Presence {
  const isOnline = async (userId: string): Promise<boolean> => {
    checkName("isOnline", userId);
    const { io } = hub;
    if (io === undefined) {
      return false;
    }
    if (hub.probe.local()) {
      return (io.sockets.adapter.rooms.get(userRoom(userId))?.size ?? 0) > 0;
    }
    return (await io.in(userRoom(userId)).fetchSockets()).length > 0;
  };
  const users = async (room: string): Promise<string[]> => {
    checkName("users", room);
    return await usersInRoom(hub, records, room);
  };
  return Object.freeze({
    isOnline,
    async lastSeen(userId: string): Promise<number | null> {
      checkName("lastSeen", userId);
      return (await isOnline(userId)) ? Date.now() : (records.lastSeen(userId) ?? null);
    },
    async count(room: string): Promise<number> {
      checkName("count", room);
      return (await usersInRoom(hub, records, room)).length;
    },
    users,
  });
}
