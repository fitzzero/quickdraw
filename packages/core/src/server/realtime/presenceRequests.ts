// Presence across a cluster (the 5.1 audit's RT-5). Asking every node with
// `io.in(room).fetchSockets()` made each node serialize every socket in the
// room (its handshake headers and cookies, auth and token, rooms and data:
// about 15.6 KB a socket, 100 KB for a bloated one) on every join and every
// user's last leave, and every node parse every answer. Here a node asks the
// others with an answered event, `quickdraw:presence`, carrying `{ room }`
// (answered with the user ids of that node's app-room records) or
// `{ userId }` (answered with whether that node has a socket of the user),
// tagged with its deployment: only ids or a boolean cross Valkey, and a node
// of another deployment answers `null`, which counts for nothing.
//
// Requests are coalesced per room and per user: one in flight, and one
// trailing request every caller that arrives meanwhile shares, sent once the
// one in flight settles, so no caller gets an answer read before it asked.
//
// A node of an earlier version does not know the event and never answers.
// A request nobody answered within `cluster.timeoutMs` falls back to the old
// read of every node's sockets for the next 30 s (warned for the first
// window of an episode, at most once every 10 minutes), so a rolling deploy
// costs one timeout per window, never a failure. That read counts what it
// always counted: a socket a raw `socket.join` put in the room, and on an
// adapter key another deployment shares, that deployment's sockets.

import { userRoom } from "../../contract/names";
import { DEFAULT_CLUSTER_TIMEOUT_MS, within } from "../cluster/acks";
import { onNodeEvent, tagged } from "../cluster/deployment";
import type { Hub } from "../emit/hub";
import type { PresenceRecords } from "./presence";

/** The server-to-server event one node asks the others for a room's users or a user's sockets on. */
export const PRESENCE_EVENT = "quickdraw:presence";

/** How long a node reads every node's sockets after a presence request went unanswered. */
export const PRESENCE_FALLBACK_MS = 30_000;

/** How long after one fallback warning a window opens without another. */
export const PRESENCE_WARN_EVERY_MS = 10 * 60_000;

/** A node's presence requests to the other nodes of its cluster, and its answers to theirs. */
export interface PresenceRequests {
  /** The users the other nodes have in app room `room`, as their records hold them. */
  users(room: string): Promise<string[]>;
  /** True when another node has a socket of `userId`. */
  online(userId: string): Promise<boolean>;
  /** Answers the other nodes' presence requests, on the server the hub was given. */
  listen(): void;
}

/** One key's requests: the one in flight, and the trailing one callers share meanwhile. */
interface Slot<T> {
  readonly running: Promise<T>;
  queued: Promise<T> | undefined;
}

/** A request coalesced by key: the one in flight, or else one trailing request shared by every caller meanwhile. */
type Coalesced = <T>(key: string, ask: () => Promise<T>) => Promise<T>;

/**
 * Coalesces requests per key: with none in flight a request is sent at
 * once; with one in flight, every caller that arrives meanwhile shares one
 * trailing request, sent once the one in flight settles.
 */
function coalescer(): Coalesced {
  const slots = new Map<string, Slot<unknown>>();
  const start = <T>(key: string, ask: () => Promise<T>): Promise<T> => {
    const running = ask();
    const slot: Slot<T> = { running, queued: undefined };
    slots.set(key, slot as Slot<unknown>);
    const settle = (): void => {
      if (slots.get(key) === slot && slot.queued === undefined) {
        slots.delete(key);
      }
    };
    running.then(settle, settle);
    return running;
  };
  return <T>(key: string, ask: () => Promise<T>): Promise<T> => {
    const slot = slots.get(key) as Slot<T> | undefined;
    if (slot === undefined) {
      return start(key, ask);
    }
    slot.queued ??= slot.running.then(
      () => start(key, ask),
      () => start(key, ask),
    );
    return slot.queued;
  };
}

/** The ids among a node's answers to a room request; `null` (another deployment) and anything else count for nothing. */
function idsOf(answers: unknown): string[] {
  const ids = new Set<string>();
  for (const answer of Array.isArray(answers) ? (answers as unknown[]) : []) {
    for (const id of Array.isArray(answer) ? (answer as unknown[]) : []) {
      if (typeof id === "string" && id !== "") {
        ids.add(id);
      }
    }
  }
  return [...ids];
}

/** The users of the other nodes' sockets in `room`, from every node's sockets (the fallback). */
async function readUsers(hub: Hub, room: string): Promise<string[]> {
  const { io } = hub;
  if (io === undefined) {
    return [];
  }
  const sockets = await io.in(room).fetchSockets();
  const ids = new Set<string>();
  for (const socket of sockets) {
    const userId = socket.data.principal?.userId;
    if (!io.sockets.sockets.has(socket.id) && typeof userId === "string" && userId !== "") {
      ids.add(userId);
    }
  }
  return [...ids];
}

/** Whether another node has a socket of `userId`, from every node's sockets (the fallback). */
async function readOnline(hub: Hub, userId: string): Promise<boolean> {
  const { io } = hub;
  if (io === undefined) {
    return false;
  }
  const sockets = await io.in(userRoom(userId)).fetchSockets();
  return sockets.some((socket) => !io.sockets.sockets.has(socket.id));
}

/** Answers the other nodes' presence requests, from this node's app-room records and its sockets. */
function answerRequests(hub: Hub, records: PresenceRecords): void {
  const { io } = hub;
  if (io === undefined) {
    return;
  }
  onNodeEvent(
    io,
    hub.logger,
    PRESENCE_EVENT,
    (payload, answer) => {
      const { room, userId } = (payload ?? {}) as Readonly<Record<string, unknown>>;
      if (typeof room === "string") {
        answer(records.users(room) ?? []);
      } else if (typeof userId === "string") {
        answer((io.sockets.adapter.rooms.get(userRoom(userId))?.size ?? 0) > 0);
      } else {
        answer(null);
      }
    },
    null,
  );
}

/** Creates the presence requests of the dispatcher whose hub this is; `now` is the clock the fallback window reads. */
export function createPresenceRequests(
  hub: Hub,
  records: PresenceRecords,
  now: () => number = Date.now,
): PresenceRequests {
  const coalesced = coalescer();
  let fallbackUntil = 0;
  let warnedAt: number | undefined;

  /** Opens a fallback window; warns for the first of an episode, at most once every 10 minutes. */
  const fallBack = (): void => {
    const at = now();
    fallbackUntil = at + PRESENCE_FALLBACK_MS;
    if (warnedAt === undefined || at - warnedAt >= PRESENCE_WARN_EVERY_MS) {
      warnedAt = at;
      hub.logger.warn(
        "A node did not answer a presence request within cluster.timeoutMs (a node of an earlier quickdraw version during a rolling deploy, a node that stopped answering, or an adapter that does not answer server-side events): presence reads every node's sockets (fetchSockets) for the next 30 s",
        { category: "quickdraw.presence" },
      );
    }
  };

  /** Asks the other nodes, or reads their sockets during a fallback window or once nobody answered. */
  const ask = async <T>(
    payload: object,
    answered: (answers: unknown) => T,
    read: () => Promise<T>,
  ) => {
    const { io } = hub;
    if (io === undefined || now() < fallbackUntil) {
      return await read();
    }
    const timeoutMs = hub.cluster?.timeoutMs ?? DEFAULT_CLUSTER_TIMEOUT_MS;
    try {
      const answers: unknown = await within(
        io.serverSideEmitWithAck(PRESENCE_EVENT, tagged(io, payload)),
        timeoutMs,
      );
      return answered(answers);
    } catch {
      fallBack();
      return await read();
    }
  };

  return Object.freeze({
    users: (room: string) =>
      coalesced(`r\u0000${room}`, () => ask({ room }, idsOf, () => readUsers(hub, room))),
    online: (userId: string) =>
      coalesced(`u\u0000${userId}`, () =>
        ask(
          { userId },
          (answers) => Array.isArray(answers) && answers.includes(true),
          () => readOnline(hub, userId),
        ),
      ),
    listen: () => {
      answerRequests(hub, records);
    },
  });
}
