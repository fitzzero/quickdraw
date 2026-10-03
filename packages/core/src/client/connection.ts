// The connection of a v5 client (RFC 0003 sections 8.1 and 11.1): one
// Socket.IO socket with the v5 handshake, its state as a snapshot to
// subscribe to, and the pushes a server sends a whole connection. Ported
// from 4.1's provider (`legacy-src/client/QuickdrawProvider.tsx:295-403`),
// without React, so a React Native or Node client uses it as it is: nothing
// here touches `window` or `document`.
//
// - The handshake sends `auth.qd = { protocol: 5, client }` beside the app's
//   credentials, and keeps the server's `qd:hello`.
// - A refused handshake says why in its `connect_error` data: another
//   protocol (`PROTOCOL_MISMATCH`, which calls `onProtocolMismatch`) or failed
//   authentication (`UNAUTHENTICATED`). Socket.IO does not retry either.
// - `qd:rotate` reconnects at a random moment within its window; `qd:access`
//   updates the grants in the state.
// - `RATE_LIMITED` answers start a backoff window per kind (`backoff.ts`).
//
// 4.1 created a socket per token and hard-coded its options
// (`legacy-src/client/QuickdrawProvider.tsx:306-312`). Here one socket lives
// as long as the connection: new credentials reconnect it, and `socketOptions`
// pass through to `io()`. Caches are never cleared on a disconnect; later
// cards resume live data by revision.

import { io, type ManagerOptions, type Socket, type SocketOptions } from "socket.io-client";
import type { AccessLevel } from "../contract/access";
import { SERVER_EVENTS } from "../contract/names";
import type { ClientToServerEvents, ServerToClientEvents } from "../protocol/envelope";
import { isRecord } from "../protocol/guards";
import { createJsonParser } from "../protocol/parser";
import {
  PROTOCOL_VERSION,
  isAuthenticationRefused,
  isProtocolMismatch,
  type AuthenticationRefused,
  type HelloFrame,
  type ProtocolMismatch,
} from "../protocol/version";
import { QUICKDRAW_VERSION } from "../version";
import { createBackoff, type Backoff, type BackoffKind, type BackoffWindows } from "./backoff";
import { reloadOncePerSession } from "./reload";

/** The client's Socket.IO socket, typed with the v5 frames. */
export type QuickdrawSocket = Socket<ServerToClientEvents, ClientToServerEvents>;

/** Socket.IO client options: `io(url, options)`. */
export type SocketClientOptions = Partial<ManagerOptions & SocketOptions>;

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
  /** How long a call waits for its answer before it fails with `TIMEOUT`. Default 10,000 ms. */
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
  /** The server's last `qd:hello`, or `null` before the first one. */
  readonly hello: HelloFrame | null;
  /**
   * The service grants the server last pushed with `qd:access`, or `null`
   * when it has pushed none since the credentials last changed. Protocol 5
   * pushes them when they change, not when a socket connects.
   */
  readonly serviceAccess: Readonly<Record<string, AccessLevel>> | null;
  /** Why the last handshake was refused, while `status` is `refused`. */
  readonly refusal: ConnectionRefusal | null;
  /** When each kind's rate-limit backoff ends; a kind that is not backing off is absent. */
  readonly backoff: BackoffWindows;
}

/** A v5 client connection. */
export interface QuickdrawConnection {
  readonly url: string;
  /** The default time limit of a call, in milliseconds. */
  readonly timeoutMs: number;
  /** The socket, created unconnected with the connection and kept for its lifetime. */
  readonly socket: QuickdrawSocket;
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
}

const DEFAULT_TIMEOUT_MS = 10_000;

const INITIAL_STATE: ConnectionState = Object.freeze({
  status: "idle",
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

function checkOptions(options: QuickdrawConnectionOptions): number {
  if (typeof options.url !== "string" || options.url === "") {
    throw new TypeError("createQuickdrawConnection: url must be the server's URL");
  }
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  if (!isTimeLimit(timeoutMs)) {
    throw new TypeError(
      "createQuickdrawConnection: timeoutMs must be a number of milliseconds, above 0 and at most 2^31 - 1",
    );
  }
  return timeoutMs;
}

function createSocket(
  options: QuickdrawConnectionOptions,
  handshake: () => Record<string, unknown>,
): QuickdrawSocket {
  return io(options.url, {
    forceNew: true,
    withCredentials: true,
    transports: ["websocket", "polling"],
    ...(options.binary === true ? {} : { parser: createJsonParser() }),
    ...options.socketOptions,
    ...(options.transports === undefined ? {} : { transports: options.transports }),
    autoConnect: false,
    auth: (send: (data: object) => void) => {
      send(handshake());
    },
  });
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

function createLifecycle(socket: QuickdrawSocket, store: StateStore, backoff: Backoff): Lifecycle {
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
    clearTimeout(rotateTimer);
    rotateTimer = undefined;
    backoff.clear();
    socket.disconnect();
    store.set({ status: "idle" });
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

/** The pushes a server sends the whole connection, and the handshake's outcome. */
function listen(
  socket: QuickdrawSocket,
  store: StateStore,
  lifecycle: Lifecycle,
  onProtocolMismatch: (mismatch: ProtocolMismatch) => void,
): void {
  socket.on("connect", () => {
    store.set({ status: "connected", refusal: null });
  });
  socket.on("disconnect", () => {
    store.set({ status: socket.active ? "connecting" : lifecycle.stoppedStatus() });
  });
  socket.on("connect_error", (error: Error & { readonly data?: unknown }) => {
    if (socket.active) {
      return;
    }
    const refusal = refusalOf(error);
    store.set({ status: "refused", refusal });
    if (refusal.code === "PROTOCOL_MISMATCH") {
      onProtocolMismatch(refusal);
    }
  });
  socket.on(SERVER_EVENTS.hello, (frame) => {
    store.set({ hello: frame });
  });
  socket.on(SERVER_EVENTS.access, (frame) => {
    if (isRecord(frame) && isRecord(frame.serviceAccess)) {
      store.set({ serviceAccess: frame.serviceAccess as Readonly<Record<string, AccessLevel>> });
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
  const timeoutMs = checkOptions(options);
  const store = createStore();
  const backoff = createBackoff((windows) => {
    store.set({ backoff: windows });
  });
  let auth = options.auth;
  let nextId = 0;
  const socket = createSocket(options, () => ({
    ...credentialsOf(auth),
    qd: { protocol: PROTOCOL_VERSION, client: QUICKDRAW_VERSION },
  }));
  const lifecycle = createLifecycle(socket, store, backoff);
  listen(socket, store, lifecycle, options.onProtocolMismatch ?? reloadOncePerSession);

  return Object.freeze({
    url: options.url,
    timeoutMs,
    socket,
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
      store.set({ serviceAccess: null });
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
  });
}
