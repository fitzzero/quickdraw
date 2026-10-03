// The frame recorder of `createTestApp` (RFC 0003 section 13): every frame
// the server sends any socket of the test app, as the server sent it to that
// socket, with the user the socket acts for and when it was sent. Tests
// assert on frames this way instead of putting raw listeners on client
// sockets, and it covers every client: sockets from `app.connect`, client
// connections from `./testing/client`, and any other.
//
// It records what goes out through Socket.IO's outgoing-packet hook on each
// server socket, which sees direct emits and room broadcasts alike, so an
// entity frame stripped for one access tier is recorded as that tier's
// sockets received it. Events are recorded by name, whatever they are: the
// v5 frames (`qd:hello`, `qd:e`, `qd:c`, `qd:changed`, `qd:revoked`,
// `qd:access`, `qd:rotate`, and `qd:event` and `qd:stream` once services
// send them) and an app's own. Acknowledgements are replies, not frames, and
// are not recorded.

import type { ServerEventName } from "../contract/names";
import type { ServerToClientEvents } from "../protocol/envelope";
import type { QuickdrawIo } from "../server/transports/types";

/** The payload of a v5 server event, by its name. */
export type ServerFrameOf<E extends ServerEventName> = Parameters<ServerToClientEvents[E]>[0];

/** One frame the server sent one socket. */
export interface RecordedFrame<Data = unknown> {
  /** The event: `"qd:e"`, `"qd:c"`, `"qd:changed"`, ... */
  readonly event: string;
  /** The frame: the event's first argument. */
  readonly data: Data;
  /** Every argument of the event, for an app's own events that send more than one. */
  readonly args: readonly unknown[];
  /** The id of the socket it was sent to; the client socket's `id` is the same. */
  readonly socketId: string;
  /** The user the socket acts for, or `null` for an anonymous socket. */
  readonly userId: string | null;
  /** When the server sent it: `Date.now()`. */
  readonly at: number;
}

/** Which frames to take: all that match every field given. */
export interface FrameQuery<E extends string = string> {
  readonly event?: E;
  readonly socketId?: string;
  /** The user the socket acts for; `null` for anonymous sockets. */
  readonly userId?: string | null;
}

/** A query, or a predicate over recorded frames. */
export type FrameMatch = FrameQuery | ((frame: RecordedFrame) => boolean);

/**
 * `app.frames`: every frame the test app's server sent since it started (or
 * since `clear()`), oldest first.
 *
 * @example
 * app.frames({ event: "qd:e", userId: cy.id }).map((frame) => frame.data);
 * app.frames.clear();
 * await app.server.dispatcher.caller(alice).taskService.rename({ id, title });
 * await app.frames.waitFor({ event: "qd:changed", userId: bob.id });
 */
export interface FrameRecorder {
  /** The frames of one v5 event that match `query`, typed by the event. */
  <E extends ServerEventName>(
    query: FrameQuery<E> & { readonly event: E },
  ): RecordedFrame<ServerFrameOf<E>>[];
  /** The frames that match `match`, or every frame. */
  (match?: FrameMatch): RecordedFrame[];
  /** Forgets every frame recorded so far. */
  clear(): void;
  /**
   * Resolves with the first frame that matches: one recorded already (since
   * the last `clear()`), or the next one sent. Rejects when none arrives
   * within `timeoutMs` (default 5,000).
   */
  waitFor<E extends ServerEventName>(
    query: FrameQuery<E> & { readonly event: E },
    timeoutMs?: number,
  ): Promise<RecordedFrame<ServerFrameOf<E>>>;
  waitFor(match: FrameMatch, timeoutMs?: number): Promise<RecordedFrame>;
}

const DEFAULT_WAIT_MS = 5000;

/** A `waitFor` still waiting. */
interface Waiter {
  readonly matches: (frame: RecordedFrame) => boolean;
  readonly resolve: (frame: RecordedFrame) => void;
}

/** The predicate `match` stands for. */
function predicateOf(match: FrameMatch | undefined): (frame: RecordedFrame) => boolean {
  if (match === undefined) {
    return () => true;
  }
  if (typeof match === "function") {
    return match;
  }
  return (frame) =>
    (match.event === undefined || frame.event === match.event) &&
    (match.socketId === undefined || frame.socketId === match.socketId) &&
    (match.userId === undefined || frame.userId === match.userId);
}

/** The text a timed-out `waitFor` names its match with. */
function describeMatch(match: FrameMatch): string {
  return typeof match === "function" ? "the predicate" : JSON.stringify(match);
}

/**
 * Records every frame `io`'s server sends from now on. Its middleware runs
 * after the server's own, once a socket is authenticated, so a socket the
 * server refuses records nothing and `qd:hello` is the first frame of each.
 */
export function recordFrames(io: QuickdrawIo): FrameRecorder {
  const frames: RecordedFrame[] = [];
  const waiters = new Set<Waiter>();

  io.use((serverSocket, next) => {
    serverSocket.onAnyOutgoing((event: string, ...args: unknown[]) => {
      const frame: RecordedFrame = Object.freeze({
        event,
        data: args[0],
        args: Object.freeze([...args]),
        socketId: serverSocket.id,
        userId: serverSocket.data.principal?.userId ?? null,
        at: Date.now(),
      });
      frames.push(frame);
      for (const waiter of [...waiters]) {
        if (waiter.matches(frame)) {
          waiters.delete(waiter);
          waiter.resolve(frame);
        }
      }
    });
    next();
  });

  const waitFor = (match: FrameMatch, timeoutMs = DEFAULT_WAIT_MS): Promise<RecordedFrame> => {
    const matches = predicateOf(match);
    const found = frames.find(matches);
    if (found !== undefined) {
      return Promise.resolve(found);
    }
    return new Promise<RecordedFrame>((resolve, reject) => {
      const timer = setTimeout(() => {
        waiters.delete(waiter);
        reject(new Error(`No frame matched ${describeMatch(match)} within ${timeoutMs} ms`));
      }, timeoutMs);
      const waiter: Waiter = {
        matches,
        resolve: (frame) => {
          clearTimeout(timer);
          resolve(frame);
        },
      };
      waiters.add(waiter);
    });
  };

  const recorder = (match?: FrameMatch): RecordedFrame[] => frames.filter(predicateOf(match));
  return Object.assign(recorder, {
    clear: (): void => {
      frames.length = 0;
    },
    waitFor,
  }) as FrameRecorder;
}
