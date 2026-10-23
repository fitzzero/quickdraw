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
// A stream's subscriber count (`StreamHandle.subscribers`) asks the same
// way with `{ sockets }`, a stream room, answered with how many of that
// node's sockets are in it: one number per node crosses Valkey, never a
// socket. A node that knows the event but not `{ sockets }` answers `null`,
// which counts for nothing.
//
// Socket.IO hands a request's answers over together: while one node does
// not answer, the others' come only with the adapter's own request timeout,
// which hands over the answers that arrived. So a request waits for that
// timeout (`requestsTimeout`, the Redis adapter's, which `setupRedisAdapter`
// sets to `cluster.timeoutMs`) plus `ADAPTER_MARGIN_MS`, never changing an
// adapter the app built, and counts the answers that came: a silent node's
// users and sockets are missing, the other nodes' are not. With an adapter
// that exposes no such timeout it waits `cluster.timeoutMs`, and a request
// one node leaves unanswered counts nothing from the others. Either way it
// warns how many nodes answered, at most once every 10 minutes for
// presence and once for counts, and never throws: a job that counts to skip
// work counts again on its next round. A node of a version before 5.1.1
// does not know the event and never answers, so during a rolling deploy
// from one its users are missing from presence until it is replaced (5.1.1
// to 5.1.3 read every node's sockets for 30 s instead, which threw after
// the adapter's timeout while a node stayed frozen).

import { STREAM_ROOM_PREFIX, userRoom } from "../../contract/names";
import { DEFAULT_CLUSTER_TIMEOUT_MS, within } from "../cluster/acks";
import { onNodeEvent, tagged } from "../cluster/deployment";
import type { Hub } from "../emit/hub";
import type { QuickdrawIo } from "../transports/types";
import type { PresenceRecords } from "./presence";

/** The server-to-server event one node asks the others for a room's users or a user's sockets on. */
export const PRESENCE_EVENT = "quickdraw:presence";

/** How long past the adapter's own request timeout a request waits for the answers it hands over then. */
export const ADAPTER_MARGIN_MS = 250;

/** How long after one warning that a node did not answer the next one may be logged, per kind. */
export const PRESENCE_WARN_EVERY_MS = 10 * 60_000;

/** A node's presence requests to the other nodes of its cluster, and its answers to theirs. */
export interface PresenceRequests {
  /** The users the other nodes have in app room `room`, as their records hold them. */
  users(room: string): Promise<string[]>;
  /** True when another node has a socket of `userId`. */
  online(userId: string): Promise<boolean>;
  /**
   * How many sockets the other nodes have in stream room `room`; a node that
   * does not answer in time counts as 0, the others' answers count.
   */
  sockets(room: string): Promise<number>;
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

/**
 * The sockets the answers to a count add up to. An answer that is not a
 * count (`null`: another deployment, or a node of an earlier version) counts
 * for nothing.
 */
function countOf(answers: unknown): number {
  let total = 0;
  for (const answer of Array.isArray(answers) ? (answers as unknown[]) : []) {
    if (typeof answer === "number" && Number.isSafeInteger(answer) && answer > 0) {
      total += answer;
    }
  }
  return total;
}

/** The answers a timed-out request did get: Socket.IO hands them over on the adapter's own timeout. */
function answersOf(error: unknown): unknown {
  return typeof error === "object" && error !== null
    ? (error as { readonly responses?: unknown }).responses
    : undefined;
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
      const { room, userId, sockets } = (payload ?? {}) as Readonly<Record<string, unknown>>;
      if (typeof room === "string") {
        answer(records.users(room) ?? []);
      } else if (typeof userId === "string") {
        answer((io.sockets.adapter.rooms.get(userRoom(userId))?.size ?? 0) > 0);
      } else if (typeof sockets === "string" && sockets.startsWith(STREAM_ROOM_PREFIX)) {
        // Stream rooms only: counts of the framework's other rooms are no node's business.
        answer(io.sockets.adapter.rooms.get(sockets)?.size ?? 0);
      } else {
        answer(null);
      }
    },
    null,
  );
}

/** The longest delay a timer honors (2^31 - 1 ms). */
const MAX_TIMER_MS = 2_147_483_647;

/**
 * How long a request to the other nodes waits: the adapter's own request
 * timeout plus `ADAPTER_MARGIN_MS` when it exposes one (the Redis adapter's
 * `requestsTimeout`), so the answers that came arrive with that timeout;
 * else `cluster.timeoutMs`.
 */
export function requestDeadlineOf(hub: Hub, io: QuickdrawIo): number {
  const adapter = (io.sockets as { readonly adapter?: unknown }).adapter;
  const own =
    typeof adapter === "object" && adapter !== null
      ? (adapter as { readonly requestsTimeout?: unknown }).requestsTimeout
      : undefined;
  if (
    typeof own === "number" &&
    Number.isFinite(own) &&
    own > 0 &&
    own + ADAPTER_MARGIN_MS <= MAX_TIMER_MS
  ) {
    return own + ADAPTER_MARGIN_MS;
  }
  return hub.cluster?.timeoutMs ?? DEFAULT_CLUSTER_TIMEOUT_MS;
}

/** The other nodes' answers to one request: all of them, or those that came before its deadline. */
interface Answered {
  readonly answers: unknown;
  /** False when a node did not answer in time: `answers` holds those the adapter handed over, if any. */
  readonly complete: boolean;
  readonly error?: unknown;
}

/** Asks the other nodes with `payload`, tagged with this server's deployment, and keeps what they answered. */
async function askNodes(hub: Hub, io: QuickdrawIo, payload: object): Promise<Answered> {
  try {
    const answers: unknown = await within(
      io.serverSideEmitWithAck(PRESENCE_EVENT, tagged(io, payload)),
      requestDeadlineOf(hub, io),
    );
    return { answers, complete: true };
  } catch (error) {
    return { answers: answersOf(error), complete: false, error };
  }
}

/**
 * Warns that a node did not answer `what` in time, and how many nodes did,
 * at most once every 10 minutes by the clock `now`.
 */
function warnUnanswered(
  hub: Hub,
  now: () => number,
  what: string,
  holds: string,
): (answered: Answered) => void {
  let warnedAt: number | undefined;
  return ({ answers, error }) => {
    const at = now();
    if (warnedAt !== undefined && at - warnedAt < PRESENCE_WARN_EVERY_MS) {
      return;
    }
    warnedAt = at;
    const count = Array.isArray(answers) ? answers.length : 0;
    hub.logger.warn(
      `A node did not answer ${what} in time: ${count} other ${count === 1 ? "node" : "nodes"} answered, and ${holds} (a node that stopped answering, a node of a quickdraw version before 5.1.1 during a rolling deploy, or an adapter that does not answer server-side events)`,
      {
        category: "quickdraw.presence",
        answered: count,
        reason: error instanceof Error ? error.message : String(error),
      },
    );
  };
}

/** Creates the presence requests of the dispatcher whose hub this is; `now` is the clock its warnings are spaced by. */
export function createPresenceRequests(
  hub: Hub,
  records: PresenceRecords,
  now: () => number = Date.now,
): PresenceRequests {
  const coalesced = coalescer();
  const presenceUnanswered = warnUnanswered(
    hub,
    now,
    "a presence request",
    "presence holds their users",
  );
  const countUnanswered = warnUnanswered(
    hub,
    now,
    "a stream's subscriber count",
    "the count holds their sockets",
  );

  /** Asks the other nodes and reads what they answered, all of it or what came in time. */
  const ask = async <T>(
    payload: object,
    read: (answers: unknown) => T,
    unanswered: (answered: Answered) => void,
  ): Promise<T> => {
    const { io } = hub;
    if (io === undefined) {
      return read([]);
    }
    const answered = await askNodes(hub, io, payload);
    if (!answered.complete) {
      unanswered(answered);
    }
    return read(answered.answers);
  };

  return Object.freeze({
    users: (room: string) =>
      coalesced(`r\u0000${room}`, () => ask({ room }, idsOf, presenceUnanswered)),
    online: (userId: string) =>
      coalesced(`u\u0000${userId}`, () =>
        ask(
          { userId },
          (answers) => Array.isArray(answers) && answers.includes(true),
          presenceUnanswered,
        ),
      ),
    sockets: (room: string) =>
      coalesced(`s\u0000${room}`, () => ask({ sockets: room }, countOf, countUnanswered)),
    listen: () => {
      answerRequests(hub, records);
    },
  });
}
