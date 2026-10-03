// The connection of a v5 client (RFC 0003 sections 8.1, 11.1 and 11.3): one
// Socket.IO socket with the v5 handshake, its state as a snapshot to
// subscribe to, the pushes a server sends a whole connection, and the change
// topics it watches. Ported from 4.1's provider
// (`legacy-src/client/QuickdrawProvider.tsx:295-403`), without React, so a
// React Native or Node client uses it as it is: nothing here touches
// `window` or `document`.
//
// - The handshake sends `auth.qd = { protocol: 5, client }` beside the app's
//   credentials, and keeps the server's `qd:hello`: who the socket acts for,
//   its grants, and the limits. Once it is known, a call waits the server's
//   `callTimeoutMs` plus 2 s by default, so a slow call ends with the
//   server's `TIMEOUT` rather than the client's.
// - A refused handshake says why in its `connect_error` data: another
//   protocol (`PROTOCOL_MISMATCH`, which calls `onProtocolMismatch`) or failed
//   authentication (`UNAUTHENTICATED`). Socket.IO does not retry either.
// - `qd:rotate` reconnects at a random moment within its window; `qd:access`
//   updates the grants in the state.
// - `RATE_LIMITED` answers start a backoff window per kind (`backoff.ts`).
// - A connection that drops and comes back with the same credentials (or
//   rotates) is `reconnecting` meanwhile, joins its watched topics again
//   (`watch.ts`) and tells `onReconnect` listeners, which refetch what may
//   have changed (the provider, through the coordinator).
// - Subscription events (`qd:sub`, `qd:col:sub`, `qd:col:items`,
//   `qd:watch`) go through the connection's lane (`lane.ts`), paced by the
//   server's `limits.subscriptions`.
//
// 4.1 created a socket per token and hard-coded its options
// (`legacy-src/client/QuickdrawProvider.tsx:306-312`), and cleared every
// subscription on a disconnect (`:326-330`). Here one socket lives as long as
// the connection (`socket.ts`): new credentials reconnect it, and
// `socketOptions` pass through to `io()`. Caches are never cleared on a
// disconnect.

import { SERVER_EVENTS } from "../contract/names";
import { isRecord } from "../protocol/guards";
import {
  isAuthenticationRefused,
  isProtocolMismatch,
  type AuthenticationRefused,
  type HelloFrame,
  type ProtocolMismatch,
} from "../protocol/version";
import { createBackoff, type Backoff, type BackoffKind, type BackoffWindows } from "./backoff";
import { createSubscriptionLane, type SubscriptionLane } from "./lane";
import { reloadOncePerSession } from "./reload";
import { createSocket, type QuickdrawSocket, type SocketClientOptions } from "./socket";
import { createTopics, notifyEach, type Topics, type TopicWatch } from "./watch";

export type { QuickdrawSocket, SocketClientOptions };

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
 * - `connecting`: opening, or reopening after it was lost (Socket.IO retries);
 * - `connected`;
 * - `disconnected`: the server ended it, and it does not retry;
 * - `refused`: the server refused the handshake (see `refusal`).
 */
export type ConnectionStatus = "idle" | "connecting" | "connected" | "disconnected" | "refused";

/** Why the server refused a handshake: another protocol, failed authentication, or something else. */
export type ConnectionRefusal =
  | ProtocolMismatch
  | AuthenticationRefused
  | { readonly code: "REFUSED"; readonly message: string };

/** A snapshot of a connection's state. A new object whenever anything in it changes. */
export interface ConnectionState {
  readonly status: ConnectionStatus;
  /**
   * True while the connection is `connecting` again after it was connected
   * with its current credentials: the socket dropped, or the server asked it
   * to rotate. Queries keep running meanwhile (their calls wait in the send
   * buffer); `setAuth` and `close` end it.
   */
  readonly reconnecting: boolean;
  /** The server's `qd:hello` on the current credentials, or `null` before it arrives. */
  readonly hello: HelloFrame | null;
  /**
   * The principal's service grants: from the server's `qd:hello`, then from
   * every `qd:access` push; `null` before the hello on the current
   * credentials arrives.
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
  /** Disconnects and stays idle until `open`. Calls in flight fail. */
  close(): void;
  /**
   * Opens the connection for one user of it (a mounted provider) and returns
   * the release. The last release closes it on the next tick, unless the
   * connection is retained again first, so React's strict mode, which mounts
   * effects twice, does not reconnect.
   */
  retain(): () => void;
  /**
   * Changes the credentials. When they differ from the current ones (compared
   * by value), an open connection reconnects with them and this returns true.
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
}

const DEFAULT_TIMEOUT_MS = 10_000;

/** How much longer than the server's time limit a call waits, so the server's `TIMEOUT` arrives first. */
const HELLO_TIMEOUT_MARGIN_MS = 2_000;

const INITIAL_STATE: ConnectionState = Object.freeze({
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
  let state = INITIAL_STATE;
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

/** Equal credentials give equal keys, whatever the order of their fields at any depth. */
function authKey(auth: ConnectionAuth): string {
  if (typeof auth === "string") {
    return `token:${auth}`;
  }
  const sorted = (_key: string, value: unknown): unknown =>
    isRecord(value)
      ? Object.fromEntries(Object.entries(value).sort(([a], [b]) => (a < b ? -1 : 1)))
      : value;
  return `fields:${JSON.stringify(auth ?? {}, sorted)}`;
}

function refusalOf(error: Error & { readonly data?: unknown }): ConnectionRefusal {
  if (isProtocolMismatch(error.data)) {
    return { code: error.data.code, expected: error.data.expected };
  }
  if (isAuthenticationRefused(error.data)) {
    return { code: "UNAUTHENTICATED" };
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
 * connection last opened (the next connect is then a reconnect), and the
 * topics, which stop retrying when the connection closes.
 */
interface Session {
  established: boolean;
  readonly topics: Topics;
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
    clearTimeout(rotateTimer);
    rotateTimer = undefined;
    backoff.clear();
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

/** What the socket's own events update: the state, the session (and its topics) and the reconnect listeners. */
interface Wiring {
  readonly socket: QuickdrawSocket;
  readonly store: StateStore;
  readonly lifecycle: Lifecycle;
  readonly session: Session;
  readonly reconnected: Set<() => void>;
  readonly onProtocolMismatch: (mismatch: ProtocolMismatch) => void;
}

/** The socket's connects, disconnects and refusals. */
function listenToSocket(wiring: Wiring): void {
  const { socket, store, lifecycle, session } = wiring;
  socket.on("connect", () => {
    const again = session.established;
    session.established = true;
    store.set({ status: "connected", reconnecting: false, refusal: null });
    session.topics.rejoin();
    if (again) {
      notifyEach(wiring.reconnected, (listener) => {
        listener();
      });
    }
  });
  socket.on("disconnect", () => {
    const status = socket.active ? "connecting" : lifecycle.stoppedStatus();
    store.set({ status, reconnecting: status === "connecting" && session.established });
  });
  socket.on("connect_error", (error: Error & { readonly data?: unknown }) => {
    if (socket.active) {
      return;
    }
    const refusal = refusalOf(error);
    session.established = false;
    store.set({ status: "refused", reconnecting: false, refusal });
    if (refusal.code === "PROTOCOL_MISMATCH") {
      wiring.onProtocolMismatch(refusal);
    }
  });
}

/** The pushes a server sends the whole connection. */
function listenToPushes(wiring: Wiring): void {
  const { socket, store, lifecycle } = wiring;
  socket.on(SERVER_EVENTS.hello, (frame) => {
    const grants = isRecord(frame) && isRecord(frame.serviceAccess) ? frame.serviceAccess : null;
    store.set({ hello: frame, serviceAccess: grants as HelloFrame["serviceAccess"] | null });
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
  const session: Session = { established: false, topics };
  const lifecycle = createLifecycle(socket, store, backoff, session);
  const reconnected = new Set<() => void>();
  const wiring: Wiring = {
    socket,
    store,
    lifecycle,
    session,
    reconnected,
    onProtocolMismatch: options.onProtocolMismatch ?? reloadOncePerSession,
  };
  listenToSocket(wiring);
  listenToPushes(wiring);

  return Object.freeze({
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
      session.established = false;
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
    onReconnect(listener: () => void): () => void {
      reconnected.add(listener);
      return () => {
        reconnected.delete(listener);
      };
    },
    watch: topics.watch,
  });
}
