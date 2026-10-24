// The connection of a v5 client (RFC 0003 sections 8.1, 11.1 and 11.3): one
// Socket.IO socket with the v5 handshake, its state as a snapshot to
// subscribe to, the pushes a server sends a whole connection, and the change
// topics it watches. Ported from 4.1's provider
// (4.1 `src/client/QuickdrawProvider.tsx:295-403`), without React, so a
// React Native or Node client uses it as it is: nothing here touches
// `window` or `document`.
//
// - The handshake sends `auth.qd = { protocol: 5, client }` beside the app's
//   credentials, and keeps the server's `qd:hello`: who the socket acts for,
//   its grants, and the limits. Once it is known, a call waits the server's
//   `callTimeoutMs` plus 2 s by default, so a slow call ends with the
//   server's `TIMEOUT` rather than the client's.
// - A refused handshake says why in its `connect_error` data: another
//   protocol (`PROTOCOL_MISMATCH`, which calls `onProtocolMismatch`), refused
//   credentials (`UNAUTHENTICATED`), or credentials the server could not
//   check (`INTERNAL`: its `authenticate` failed with anything but a
//   refusal, its session store down, say). Socket.IO retries none of them;
//   the connection retries the last itself, with backoff (below).
// - A session the server ends is signed out (the 5.1 audit's CLIENT-1): the
//   server's disconnect (`io server disconnect`: signed out everywhere,
//   revoked, expired, or a flooded channel) and a connect or reconnect
//   refused with `UNAUTHENTICATED` or `FORBIDDEN` (its `authenticate`
//   refused the credentials, or the handshake was forbidden) forget the
//   hello and the grants, and such a refusal fails the calls held for the
//   socket's hello with `CANCELLED`; the cache session empties every cache,
//   data a server render prefetched included (`session.ts`). A dropped
//   transport, a `qd:rotate`, another protocol or an `INTERNAL` refusal
//   keeps everything.
// - A connect or reconnect refused with `INTERNAL` stays `connecting` (and
//   `reconnecting`, after a connect on these credentials) and connects again
//   after Socket.IO's own reconnection delays (its manager's
//   `reconnectionDelay`, doubling to `reconnectionDelayMax`, with
//   `randomizationFactor`'s jitter), as often as its `reconnectionAttempts`
//   allow: a short outage of the server's session store signs nobody out.
//   With Socket.IO's reconnection off, or its attempts spent, it is
//   `refused` with that refusal, and still keeps the user.
// - `qd:rotate` reconnects at a random moment within its window; `qd:access`
//   updates the grants in the state.
// - `RATE_LIMITED` answers start a backoff window per kind (`backoff.ts`).
// - A connection that drops and comes back with the same credentials (or
//   rotates) is `reconnecting` meanwhile, joins its watched topics again
//   (`watch.ts`) and tells `onReconnect` listeners, which refetch what may
//   have changed (the provider, through the coordinator).
// - Every `qd:hello` stands for a new socket, which is in no app room until
//   a call joins it: `onHello` listeners hear each one (and the current one
//   when they start listening), to run their joining calls again
//   (`useJoin`).
// - A call goes out only on a confirmed socket: connected, and its own
//   `qd:hello` arrived, since a socket speaks for whoever its credentials
//   named when it connected, which a session cookie can change unseen. From
//   a connect or a drop until that hello the connection holds calls itself,
//   never in Socket.IO's send buffer (`CallHold`, `socket.ts`), and the
//   hello lets each go or refuses it, oldest first, before it does anything
//   else (`call.ts`). New credentials (`setAuth`), `close` and a session
//   refused fail the calls held with `CANCELLED`, as Socket.IO's buffer
//   would have sent them on the next connect, as whoever it then names.
// - Subscription events (`qd:sub`, `qd:col:sub`, `qd:col:items`,
//   `qd:watch`) go through the connection's lane (`lane.ts`), paced by the
//   server's `limits.subscriptions`.
//
// 4.1 created a socket per token and hard-coded its options
// (4.1 `src/client/QuickdrawProvider.tsx:306-312`), and cleared every
// subscription on a disconnect (`:326-330`). Here one socket lives as long as
// the connection (`socket.ts`): new credentials reconnect it, and
// `socketOptions` pass through to `io()`. Caches are kept across a disconnect
// the client did not cause the session's end with: a dropped transport or a
// rotation; a session the server ended empties them.

import { SERVER_EVENTS } from "../contract/names";
import { QuickdrawError } from "../protocol/errors";
import { isRecord } from "../protocol/guards";
import {
  isAuthenticationRefused,
  isAuthenticationUnavailable,
  isProtocolMismatch,
  type AuthenticationRefused,
  type AuthenticationUnavailable,
  type HelloFrame,
  type ProtocolMismatch,
} from "../protocol/version";
import { createBackoff, type Backoff, type BackoffKind, type BackoffWindows } from "./backoff";
import { createSubscriptionLane, type SubscriptionLane } from "./lane";
import { reloadOncePerSession } from "./reload";
import { createRetry, type Retry } from "./retry";
import {
  createCallHold,
  createSocket,
  type CallHold,
  type HeldCall,
  type QuickdrawSocket,
  type SocketClientOptions,
} from "./socket";
import { createTopics, notifyEach, type JoinWait, type Topics, type TopicWatch } from "./watch";

export type { CallHold, HeldCall, QuickdrawSocket, SocketClientOptions };

/**
 * The credentials a connection authenticates with: a token, sent as
 * `auth.token`; an object of handshake fields, sent as they are; or nothing,
 * for an anonymous connection (or one a session cookie authenticates).
 */
export type ConnectionAuth = string | Readonly<Record<string, unknown>> | null | undefined;

/** Options of {@link createQuickdrawConnection}. */
export interface QuickdrawConnectionOptions {
  /** The server's URL: `"https://api.example.com"`. */
  readonly url: string;
  /** The credentials to connect with. `setAuth` changes them. */
  readonly auth?: ConnectionAuth;
  /**
   * Socket.IO manager and socket options, passed to `io()` over the defaults
   * (`withCredentials: true`, `forceNew: true`). The connection sets `auth`
   * and `autoConnect` itself.
   */
  readonly socketOptions?: SocketClientOptions;
  /**
   * The transports to try, in order. Default `["websocket", "polling"]`;
   * React Native clients pass `["websocket"]`.
   */
  readonly transports?: SocketClientOptions["transports"];
  /**
   * `true` when the server was created with `binary: true`. By default the
   * client encodes with the JSON-only parser, as the server does (section 8.4).
   */
  readonly binary?: boolean;
  /**
   * How long a call waits for its answer before it fails with `TIMEOUT`.
   * Default: the server's `callTimeoutMs` plus 2,000 ms once its hello has
   * arrived, and 10,000 ms before.
   */
  readonly timeoutMs?: number;
  /**
   * Called when the server refuses the connection because it speaks another
   * protocol. Default: reload the page once per browser session; nothing
   * without a DOM.
   */
  readonly onProtocolMismatch?: (mismatch: ProtocolMismatch) => void;
}

/**
 * Where a connection is:
 *
 * - `idle`: not opened, or closed by the app;
 * - `connecting`: opening, or reopening after it was lost (Socket.IO
 *   retries) or after the server could not authenticate it (`INTERNAL`:
 *   the connection retries, with backoff);
 * - `connected`;
 * - `disconnected`: the server ended it, and it does not retry;
 * - `refused`: the server refused the handshake (see `refusal`).
 */
export type ConnectionStatus = "idle" | "connecting" | "connected" | "disconnected" | "refused";

/**
 * Why the server refused a handshake: another protocol, refused
 * credentials, credentials it could not check (`INTERNAL`, only once the
 * connection stopped retrying), or something else.
 */
export type ConnectionRefusal =
  | ProtocolMismatch
  | AuthenticationRefused
  | AuthenticationUnavailable
  | { readonly code: "REFUSED"; readonly message: string };

/** A snapshot of a connection's state. A new object whenever anything in it changes. */
export interface ConnectionState {
  readonly status: ConnectionStatus;
  /**
   * True while the connection is `connecting` again after it was connected
   * with its current credentials: the socket dropped, the server asked it to
   * rotate, or the server could not authenticate a reconnect (`INTERNAL`).
   * Queries keep running meanwhile (their calls are held until the new
   * socket's hello); `setAuth` and `close` end it.
   */
  readonly reconnecting: boolean;
  /**
   * The server's `qd:hello` on the current credentials, or `null` before it
   * arrives, and again once the server ended the session (its disconnect, or
   * a connect or reconnect refused with `UNAUTHENTICATED` or `FORBIDDEN`).
   */
  readonly hello: HelloFrame | null;
  /**
   * The principal's service grants: from the server's `qd:hello`, then from
   * every `qd:access` push; `null` before the hello on the current
   * credentials arrives, and once the server ended the session.
   */
  readonly serviceAccess: HelloFrame["serviceAccess"] | null;
  /** Why the last handshake was refused, while `status` is `refused`. */
  readonly refusal: ConnectionRefusal | null;
  /** When each kind's rate-limit backoff ends; a kind that is not backing off is absent. */
  readonly backoff: BackoffWindows;
}

/** A v5 client connection. */
export interface QuickdrawConnection {
  readonly url: string;
  /**
   * The default time limit of a call, in milliseconds: the `timeoutMs`
   * option when it was given; otherwise the server's `callTimeoutMs` plus
   * 2,000 once its hello has arrived, and 10,000 before.
   */
  readonly timeoutMs: number;
  /** The socket, created unconnected with the connection and kept for its lifetime. */
  readonly socket: QuickdrawSocket;
  /**
   * The lane every subscription event goes through (`qd:sub`, `qd:col:sub`,
   * `qd:col:items`, `qd:watch`): at most the server's
   * `limits.subscriptions.maxInFlight` of them unanswered at once, none while
   * the `subscription` backoff lasts.
   */
  readonly subscriptionLane: SubscriptionLane;
  /** The current state. The same object until something changes. */
  getState(): ConnectionState;
  /** Calls `listener` after every state change; returns the unsubscribe function. */
  subscribe(listener: () => void): () => void;
  /** Connects, unless the connection is connected or connecting. */
  open(): void;
  /**
   * Disconnects and stays idle until `open`. Calls in flight fail; calls
   * still held for the socket's hello fail with `CANCELLED`. No timer of the
   * connection's is left running.
   */
  close(): void;
  /**
   * Opens the connection for one user of it (a mounted provider) and returns
   * the release. The last release closes it on the next tick, unless the
   * connection is retained again first, so React's strict mode, which mounts
   * effects twice, does not reconnect.
   */
  retain(): () => void;
  /**
   * Changes the credentials. When they differ from the current ones
   * (compared by value as they are sent: a token string is the same as
   * `{ token }` with that value), the calls still held for the socket's
   * hello fail with `CANCELLED` (they were made as the last credentials, and
   * would be sent as the new ones), an open connection reconnects with the
   * new credentials, and this returns true.
   */
  setAuth(auth: ConnectionAuth): boolean;
  /** A call id, unique among this connection's calls in flight. */
  nextCallId(): number;
  /** Starts or extends `kind`'s backoff after a `RATE_LIMITED` answer. */
  reportRateLimited(kind: BackoffKind, retryAfterMs?: number): void;
  /** How long `kind` still backs off, in milliseconds; 0 when it does not. */
  backoffRemaining(kind: BackoffKind): number;
  /**
   * Calls `listener` each time the socket connects again with the same
   * credentials: after it dropped, after a `qd:rotate`, or on `open` after
   * the server ended it. Not on the first connect, nor after `setAuth` or
   * `close`. Watched topics are joined again first. Returns the unsubscribe
   * function.
   */
  onReconnect(listener: () => void): () => void;
  /**
   * Calls `listener` with every `qd:hello` the server sends: on the first
   * connect, after every reconnect (a dropped socket, a `qd:rotate`, `open`
   * after the server ended it) and after new credentials. Each hello is a
   * new socket, which is in no app room until a call joins it, so this is
   * where a client joins its rooms again (`useJoin` does it for React).
   * When the connection is connected and already has its hello, `listener`
   * is also called with it, in a microtask. Returns the unsubscribe
   * function.
   *
   * @example
   * const stop = connection.onHello(() => {
   *   void call(connection, { service: "gameService", method: "watchWorld", input: { worldId } });
   * });
   */
  onHello(listener: (hello: HelloFrame) => void): () => void;
  /**
   * Watches a change topic (RFC 0003 section 11.3): the first watch of a
   * topic sends `qd:watch` (again on every connect), the last one to end
   * sends `qd:unwatch`, and `onChanged` receives the topic's `qd:changed`
   * frames meanwhile. Returns the function that ends the watch.
   *
   * @example
   * const stop = connection.watch({
   *   service: "taskService",
   *   topic: collectionTopic("byProject", projectId),
   *   onChanged: () => void refresh(),
   * });
   */
  watch(watch: TopicWatch): () => void;
  /**
   * While the socket is connected and a watched topic's `qd:watch` is
   * unanswered, a promise that resolves once the server answers it (joined
   * or refused), the attempt fails, the topic is left or the connection
   * closes; `undefined` when there is nothing to wait for. A read sent after
   * it sees every change made before the join, so the watches with `key`
   * are not told `onJoined` for that join. The query hooks hold a watched
   * query's read with it.
   */
  waitForJoin(wait: JoinWait): Promise<void> | undefined;
}

const DEFAULT_TIMEOUT_MS = 10_000;

/** How much longer than the server's time limit a call waits, so the server's `TIMEOUT` arrives first. */
const HELLO_TIMEOUT_MARGIN_MS = 2_000;

/** The state every connection starts in, and the one a server renders (no socket opens there). */
export const INITIAL_CONNECTION_STATE: ConnectionState = Object.freeze({
  status: "idle",
  reconnecting: false,
  hello: null,
  serviceAccess: null,
  refusal: null,
  backoff: Object.freeze({}),
});

interface StateStore {
  get(): ConnectionState;
  set(patch: Partial<ConnectionState>): void;
  subscribe(listener: () => void): () => void;
}

function createStore(): StateStore {
  let state = INITIAL_CONNECTION_STATE;
  const listeners = new Set<() => void>();
  return {
    get: () => state,
    set(patch) {
      state = Object.freeze({ ...state, ...patch });
      for (const listener of [...listeners]) {
        listener();
      }
    },
    subscribe(listener) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
  };
}

function credentialsOf(auth: ConnectionAuth): Readonly<Record<string, unknown>> {
  if (typeof auth === "string") {
    return auth === "" ? {} : { token: auth };
  }
  return auth ?? {};
}

/**
 * Equal credentials give equal keys, whatever the order of their fields at
 * any depth. They are compared as they are sent: a token string and
 * `{ token }` with the same value are the same credentials.
 */
function authKey(auth: ConnectionAuth): string {
  const sorted = (_key: string, value: unknown): unknown =>
    isRecord(value)
      ? Object.fromEntries(Object.entries(value).sort(([a], [b]) => (a < b ? -1 : 1)))
      : value;
  return JSON.stringify(credentialsOf(auth), sorted);
}

/**
 * True for the reason Socket.IO gives a disconnect the server made
 * (`socket.disconnect(true)`: signed out everywhere, revoked, expired, a
 * flooded channel). A dropped transport, a ping timeout and the client's own
 * disconnect give other reasons.
 */
export function isServerDisconnect(reason: unknown): boolean {
  return reason === "io server disconnect";
}

/**
 * True while `connection`'s socket will connect unless the app closes it:
 * Socket.IO reconnects it (`socket.active`), or the connection waits to
 * connect it again because the server could not authenticate it (its
 * socket inactive, its status `connecting`). Calls made meanwhile are held
 * for the socket's hello (`callHoldOf`), and reads wait for the hello.
 */
export function mayConnect(connection: Pick<QuickdrawConnection, "socket" | "getState">): boolean {
  return connection.socket.active || connection.getState().status === "connecting";
}

/** The session of each connection `createQuickdrawConnection` made, for `credentialsEpochOf`. */
const sessions = new WeakMap<QuickdrawConnection, Session>();

/** A new connection's session: never connected, under epoch 0, holding nothing. */
function newSession(
  socket: QuickdrawSocket,
  topics: Topics,
  lane: SubscriptionLane,
  retry: Retry,
): Session {
  return { established: false, epoch: 0, hold: createCallHold(socket), topics, lane, retry };
}

/**
 * The calls `connection` holds until its socket is confirmed (connected,
 * and its own `qd:hello` arrived), and whether it is: its next hello tells
 * them before it does anything else, and new credentials, `close` and a
 * session refused fail them (`call.ts`). `undefined` for a connection made
 * elsewhere (a mock's), which holds nothing.
 */
export function callHoldOf(connection: QuickdrawConnection): CallHold | undefined {
  return sessions.get(connection)?.hold;
}

/** `connection`, frozen, with its session recorded for `credentialsEpochOf`. */
function registered(session: Session, connection: QuickdrawConnection): QuickdrawConnection {
  const frozen = Object.freeze(connection);
  sessions.set(frozen, session);
  return frozen;
}

/** New credentials: the next connect is a first one, under a new epoch (`credentialsEpochOf`). */
function renewSession(session: Session): void {
  session.established = false;
  session.epoch += 1;
  session.ended = undefined;
}

/** The server ended the session held with `hello`: a new epoch, which keeps whose it was. */
function endSession(session: Session, hello: HelloFrame | null): void {
  session.epoch += 1;
  session.ended = { hello: hello ?? session.ended?.hello ?? null };
}

/**
 * The credentials epoch of `connection`: how many times its credentials
 * changed (`setAuth` with other ones) or the server ended its session (its
 * disconnect, or a connect refused for the session). The socket's identity
 * comes from its credentials, so a call made under one epoch must not be
 * sent under another unless that one's hello names the same user
 * (`issuer.ts`). A transport drop, `qd:rotate`, `close` and `open`, and a
 * refusal the server could not check (`INTERNAL`) keep it. `0` for a
 * connection made elsewhere (a mock client's).
 */
export function credentialsEpochOf(connection: QuickdrawConnection): number {
  return sessions.get(connection)?.epoch ?? 0;
}

/**
 * Whose session the server ended to begin `connection`'s credentials epoch
 * (`credentialsEpochOf`): the hello it held then, or, when it held none,
 * the one held when the server ended a session before that (`null` if
 * none). `undefined` when the epoch began otherwise: the connection's
 * creation, or other credentials. A call made with no hello since is that
 * user's, sent only once a hello names them again (`issuer.ts`).
 */
export function endedSessionOf(
  connection: QuickdrawConnection,
): { readonly hello: HelloFrame | null } | undefined {
  return sessions.get(connection)?.ended;
}

/**
 * True for the `connect_error` data of a handshake refused for its session:
 * `UNAUTHENTICATED` or `FORBIDDEN`. `INTERNAL` (the server could not check
 * the credentials) is not one: the session stands.
 */
export function isSessionRefusal(data: unknown): boolean {
  return isRecord(data) && (data.code === "UNAUTHENTICATED" || data.code === "FORBIDDEN");
}

function refusalOf(error: Error & { readonly data?: unknown }): ConnectionRefusal {
  if (isProtocolMismatch(error.data)) {
    return { code: error.data.code, expected: error.data.expected };
  }
  if (isAuthenticationRefused(error.data)) {
    return { code: "UNAUTHENTICATED" };
  }
  if (isAuthenticationUnavailable(error.data)) {
    return { code: "INTERNAL" };
  }
  return { code: "REFUSED", message: error.message };
}

/** The longest delay a timer honors (2^31 - 1 ms); a longer one fires at once. */
const MAX_TIMEOUT_MS = 2_147_483_647;

/** True when `value` can be a call's time limit: more than 0 and at most 2^31 - 1 milliseconds. */
export function isTimeLimit(value: unknown): value is number {
  return typeof value === "number" && value > 0 && value <= MAX_TIMEOUT_MS;
}

/** The `timeoutMs` option, checked; `undefined` when it was left out. */
function checkOptions(options: QuickdrawConnectionOptions): number | undefined {
  if (typeof options.url !== "string" || options.url === "") {
    throw new TypeError("createQuickdrawConnection: url must be the server's URL");
  }
  const { timeoutMs } = options;
  if (timeoutMs !== undefined && !isTimeLimit(timeoutMs)) {
    throw new TypeError(
      "createQuickdrawConnection: timeoutMs must be a number of milliseconds, above 0 and at most 2^31 - 1",
    );
  }
  return timeoutMs;
}

/** A call's default time limit: the option, else the server's limit plus the margin, else 10 s. */
function defaultTimeout(option: number | undefined, hello: HelloFrame | null): number {
  if (option !== undefined) {
    return option;
  }
  // The frame came over the network: its shape is checked, not trusted.
  const limits: unknown = hello?.limits;
  const serverMs: unknown = isRecord(limits) ? limits.callTimeoutMs : undefined;
  const fromHello = typeof serverMs === "number" ? serverMs + HELLO_TIMEOUT_MARGIN_MS : undefined;
  return isTimeLimit(fromHello) ? fromHello : DEFAULT_TIMEOUT_MS;
}

/**
 * Whether the socket has connected with the current credentials since the
 * connection last opened (the next connect is then a reconnect), the
 * credentials epoch (`credentialsEpochOf`) and whose session the server
 * ended to begin it (`endedSessionOf`), and the topics, the
 * subscription lane and the retries after a refusal the server could not
 * authenticate (`retry.ts`), which stop retrying and waiting when the
 * connection closes.
 */
interface Session {
  established: boolean;
  epoch: number;
  /** Set while the epoch began with the server ending a session (`endedSessionOf`). */
  ended?: { readonly hello: HelloFrame | null } | undefined;
  /** The calls held until the socket's own hello confirms it (`callHoldOf`). */
  readonly hold: CallHold;
  readonly topics: Topics;
  readonly lane: SubscriptionLane;
  readonly retry: Retry;
}

/** When the socket opens and closes: the app's `open`, `close` and `retain`, new credentials, `qd:rotate`. */
interface Lifecycle {
  open(): void;
  close(): void;
  retain(): () => void;
  /** Reconnects an open connection, for new credentials. */
  reconnect(): void;
  /** Reconnects at a random moment within `withinMs` (`qd:rotate`). */
  rotateWithin(withinMs: number): void;
  /** The status a socket that will not retry is in: closed by the app, or ended by the server. */
  stoppedStatus(): ConnectionStatus;
}

function createLifecycle(
  socket: QuickdrawSocket,
  store: StateStore,
  backoff: Backoff,
  session: Session,
): Lifecycle {
  let opened = false;
  let switching = false;
  let users = 0;
  let closeTimer: ReturnType<typeof setTimeout> | undefined;
  let rotateTimer: ReturnType<typeof setTimeout> | undefined;

  function connect(): void {
    socket.connect();
    store.set({ status: "connecting", refusal: null });
  }

  function reconnect(): void {
    if (!opened) {
      return;
    }
    switching = true;
    socket.disconnect();
    switching = false;
    connect();
  }

  function open(): void {
    clearTimeout(closeTimer);
    closeTimer = undefined;
    opened = true;
    if (!socket.connected && !socket.active) {
      connect();
    }
  }

  function close(): void {
    opened = false;
    session.established = false;
    session.topics.stop();
    session.lane.stop();
    session.retry.stop();
    clearTimeout(closeTimer);
    closeTimer = undefined;
    clearTimeout(rotateTimer);
    rotateTimer = undefined;
    backoff.clear();
    // A call waiting to be sent would go out on the next `open`, long after the app closed.
    session.hold.fail(
      new QuickdrawError("CANCELLED", "The connection closed before the call was sent"),
    );
    socket.disconnect();
    store.set({ status: "idle", reconnecting: false });
  }

  function retain(): () => void {
    users += 1;
    open();
    let released = false;
    return () => {
      if (!released) {
        released = true;
        users -= 1;
        if (users === 0) {
          closeTimer = setTimeout(close, 0);
        }
      }
    };
  }

  function rotateWithin(withinMs: number): void {
    if (rotateTimer === undefined) {
      rotateTimer = setTimeout(() => {
        rotateTimer = undefined;
        reconnect();
      }, Math.random() * withinMs);
    }
  }

  function stoppedStatus(): ConnectionStatus {
    if (switching) {
      return "connecting";
    }
    return opened ? "disconnected" : "idle";
  }

  return { open, close, retain, reconnect, rotateWithin, stoppedStatus };
}

/** One `onHello` listener, and the last hello it was given, so no hello reaches it twice. */
interface HelloListener {
  readonly listener: (hello: HelloFrame) => void;
  last: HelloFrame | undefined;
}

/** What the socket's own events update: the state, the session (and its topics) and the listeners. */
interface Wiring {
  readonly socket: QuickdrawSocket;
  readonly store: StateStore;
  readonly lifecycle: Lifecycle;
  readonly session: Session;
  readonly reconnected: Set<() => void>;
  readonly hellos: Set<HelloListener>;
  readonly onProtocolMismatch: (mismatch: ProtocolMismatch) => void;
}

/** Gives `entry` the hello, unless it was given that one already or stopped listening. */
function sayHello(
  hellos: ReadonlySet<HelloListener>,
  entry: HelloListener,
  hello: HelloFrame,
): void {
  if (hellos.has(entry) && entry.last !== hello) {
    entry.last = hello;
    entry.listener(hello);
  }
}

/** Adds `listener` to `set`; returns the function that takes it out again. */
function addListener<T>(set: Set<T>, listener: T): () => void {
  set.add(listener);
  return () => {
    set.delete(listener);
  };
}

/** `connection.onHello`: every hello from now on, and the current one in a microtask. */
function listenForHellos(
  wiring: Pick<Wiring, "hellos" | "store">,
  listener: (hello: HelloFrame) => void,
): () => void {
  const { hellos, store } = wiring;
  const entry: HelloListener = { listener, last: undefined };
  hellos.add(entry);
  const { status, hello } = store.get();
  if (status === "connected" && hello !== null) {
    queueMicrotask(() => {
      notifyEach([entry], (current) => {
        sayHello(hellos, current, hello);
      });
    });
  }
  return () => {
    hellos.delete(entry);
  };
}

/** The socket's connects, disconnects and refusals. */
function listenToSocket(wiring: Wiring): void {
  const { socket, store, lifecycle, session } = wiring;
  socket.on("connect", () => {
    // A new socket: whom the server takes it for is known once its own hello arrives.
    session.hold.unconfirm();
    const again = session.established;
    session.established = true;
    session.retry.connected();
    store.set({ status: "connected", reconnecting: false, refusal: null });
    session.topics.rejoin();
    if (again) {
      notifyEach(wiring.reconnected, (listener) => {
        listener();
      });
    }
  });
  socket.on("disconnect", (reason: unknown) => {
    const status = socket.active ? "connecting" : lifecycle.stoppedStatus();
    // The server ended the session: who it was is no longer known.
    const ended = isServerDisconnect(reason);
    if (ended) {
      endSession(session, store.get().hello);
    }
    store.set({
      status,
      reconnecting: status === "connecting" && session.established,
      ...(ended ? { hello: null, serviceAccess: null } : {}),
    });
  });
  socket.on("connect_error", (error: Error & { readonly data?: unknown }) => {
    if (socket.active) {
      return;
    }
    if (isAuthenticationUnavailable(error.data) && session.retry.later()) {
      // The server could not check the credentials (its session store is down, say): they may
      // well be good, so who the connection acts for stands, and it connects again by itself.
      store.set({ status: "connecting", reconnecting: session.established, refusal: null });
      return;
    }
    const refusal = refusalOf(error);
    session.established = false;
    const ended = isSessionRefusal(error.data);
    if (ended) {
      endSession(session, store.get().hello);
      // They would go out on the next connect, as whoever the credentials then name.
      session.hold.fail(
        new QuickdrawError("CANCELLED", "The session ended before the call was sent"),
      );
    }
    store.set({
      status: "refused",
      reconnecting: false,
      refusal,
      ...(ended ? { hello: null, serviceAccess: null } : {}),
    });
    if (refusal.code === "PROTOCOL_MISMATCH") {
      wiring.onProtocolMismatch(refusal);
    }
  });
}

/** The pushes a server sends the whole connection. */
function listenToPushes(wiring: Wiring): void {
  const { socket, store, lifecycle, session } = wiring;
  socket.on(SERVER_EVENTS.hello, (frame) => {
    // The calls held for it go first (or are refused), before anything the hello sets off.
    session.hold.confirm(frame);
    const grants = isRecord(frame) && isRecord(frame.serviceAccess) ? frame.serviceAccess : null;
    store.set({ hello: frame, serviceAccess: grants as HelloFrame["serviceAccess"] | null });
    notifyEach(wiring.hellos, (entry) => {
      sayHello(wiring.hellos, entry, frame);
    });
  });
  socket.on(SERVER_EVENTS.access, (frame) => {
    if (isRecord(frame) && isRecord(frame.serviceAccess)) {
      store.set({ serviceAccess: frame.serviceAccess as HelloFrame["serviceAccess"] });
    }
  });
  socket.on(SERVER_EVENTS.rotate, (frame) => {
    const withinMs: unknown = isRecord(frame) ? frame.withinMs : undefined;
    if (typeof withinMs === "number" && Number.isFinite(withinMs) && withinMs >= 0) {
      lifecycle.rotateWithin(withinMs);
    }
  });
}

/**
 * Creates a v5 client connection to `url`. It does not connect until `open`
 * or `retain`. React apps use `QuickdrawProvider`, which owns one; other
 * clients (React Native without the provider, Node scripts) use this with
 * `call`.
 *
 * @example
 * const connection = createQuickdrawConnection({ url: "http://localhost:4000", auth: token });
 * connection.open();
 * const reply = await call(connection, { service: "taskService", method: "get", input: { id } });
 */
export function createQuickdrawConnection(
  options: QuickdrawConnectionOptions,
): QuickdrawConnection {
  const timeoutOption = checkOptions(options);
  const store = createStore();
  const backoff = createBackoff((windows) => {
    store.set({ backoff: windows });
  });
  let auth = options.auth;
  let nextId = 0;
  const socket = createSocket(options, () => credentialsOf(auth));
  const timeoutMs = (): number => defaultTimeout(timeoutOption, store.get().hello);
  const subscriptionLane = createSubscriptionLane({
    socket,
    timeoutMs,
    hello: () => store.get().hello,
    backoffRemaining: backoff.remaining,
  });
  const topics = createTopics({
    socket,
    lane: subscriptionLane,
    backoffRemaining: backoff.remaining,
    reportRateLimited: backoff.report,
  });
  // Retries run while the connection is trying to connect: `close` makes it idle.
  const retry = createRetry(socket, () => store.get().status === "connecting");
  const session = newSession(socket, topics, subscriptionLane, retry);
  const lifecycle = createLifecycle(socket, store, backoff, session);
  const reconnected = new Set<() => void>();
  const wiring: Wiring = {
    socket,
    store,
    lifecycle,
    session,
    reconnected,
    hellos: new Set(),
    onProtocolMismatch: options.onProtocolMismatch ?? reloadOncePerSession,
  };
  listenToSocket(wiring);
  listenToPushes(wiring);

  return registered(session, {
    url: options.url,
    get timeoutMs(): number {
      return timeoutMs();
    },
    socket,
    subscriptionLane,
    getState: store.get,
    subscribe: store.subscribe,
    open: lifecycle.open,
    close: lifecycle.close,
    retain: lifecycle.retain,
    setAuth(next: ConnectionAuth): boolean {
      if (authKey(next) === authKey(auth)) {
        return false;
      }
      auth = next;
      renewSession(session);
      retry.stop();
      session.hold.fail(
        new QuickdrawError("CANCELLED", "The credentials changed before the call was sent"),
      );
      store.set({ hello: null, serviceAccess: null });
      lifecycle.reconnect();
      return true;
    },
    nextCallId(): number {
      const id = nextId;
      nextId = nextId >= Number.MAX_SAFE_INTEGER ? 0 : nextId + 1;
      return id;
    },
    reportRateLimited: backoff.report,
    backoffRemaining: backoff.remaining,
    onReconnect: (listener: () => void) => addListener(reconnected, listener),
    onHello: (listener: (hello: HelloFrame) => void) => listenForHellos(wiring, listener),
    watch: topics.watch,
    waitForJoin: topics.waitForJoin,
  });
}
