// The protocol version and the connection handshake (RFC 0003 section 8.1).
// A v5 client connects with `auth: { token, qd: { protocol: 5, client } }`.
// The server answers with `qd:hello`, or refuses a client that names another
// protocol with `PROTOCOL_MISMATCH` in the `connect_error` data, and one whose
// authentication failed with `UNAUTHENTICATED` there. A client that sends no
// `auth.qd` is a 4.x client, which only the legacy shim serves (section 8.5).
// There is no capability negotiation: the version decides.

import type { AccessLevel } from "../contract/access";
import { isRecord } from "./guards";

/** The wire protocol this package speaks. */
export const PROTOCOL_VERSION = 5;

/** `auth.qd`: what a v5 client sends when it connects. */
export interface QdHandshake {
  /** The protocol the client speaks. The server refuses any but its own. */
  readonly protocol: number;
  /** The client package's version, for logs. */
  readonly client: string;
}

/** The Socket.IO `auth` a v5 client connects with. */
export interface HandshakeAuth {
  /** The session token the server's `authenticate` reads. */
  readonly token?: string;
  /** The protocol the client speaks. A client without it is a 4.x client (RFC 0003 section 8.5). */
  readonly qd: QdHandshake;
}

/**
 * True when `value` has the shape of `auth.qd`, whatever protocol it names.
 * Compare `protocol` with {@link PROTOCOL_VERSION} to decide whether to serve it.
 */
export function isQdHandshake(value: unknown): value is QdHandshake {
  return isRecord(value) && Number.isInteger(value.protocol) && typeof value.client === "string";
}

/** The code in the `connect_error` data of a connection refused for its protocol. */
export const PROTOCOL_MISMATCH = "PROTOCOL_MISMATCH";

/**
 * The `data` of the error a server refuses a connection with when the client
 * speaks another protocol, or none. It is not an `ErrorCode`: no call failed.
 */
export interface ProtocolMismatch {
  readonly code: typeof PROTOCOL_MISMATCH;
  /** The protocol the server speaks. */
  readonly expected: number;
}

/** True when a `connect_error`'s `data` says the server speaks another protocol. */
export function isProtocolMismatch(value: unknown): value is ProtocolMismatch {
  return isRecord(value) && value.code === PROTOCOL_MISMATCH && Number.isInteger(value.expected);
}

/**
 * The `data` of the error a server refuses a connection with when
 * authenticating it failed: the app's `authenticate` threw, so the
 * credentials are bad or could not be checked. A client tells it apart from
 * {@link ProtocolMismatch} by `code`; reconnecting needs other credentials.
 */
export interface AuthenticationRefused {
  readonly code: "UNAUTHENTICATED";
}

/** True when a `connect_error`'s `data` says authenticating the connection failed. */
export function isAuthenticationRefused(value: unknown): value is AuthenticationRefused {
  return isRecord(value) && value.code === "UNAUTHENTICATED";
}

/** The most ids one `qd:sub` may name (RFC 0003 section 6), as `qd:hello` announces it. */
export const MAX_SUBSCRIBE_IDS = 500;

/** The longest collection scope value or change topic a frame may name, in characters. */
export const MAX_SCOPE_LENGTH = 256;

/**
 * Each socket's lane of subscription events (`qd:sub`, `qd:col:sub`,
 * `qd:col:items`, `qd:watch`; RFC 0003 section 8.2), as `qd:hello` announces it.
 */
export interface HelloSubscriptionLimits {
  /** Subscription events one socket may have running at once. */
  readonly maxInFlight: number;
  /** Subscription events one socket may have waiting; past that one fails with `RATE_LIMITED`. */
  readonly maxQueued: number;
}

/** The limits a server announces in `qd:hello`, so a client can stay inside them. */
export interface HelloLimits {
  /** Queries one socket may have running at once; more wait in a queue (RFC 0003 section 9). */
  readonly maxInFlightQueries: number;
  /** Queries one socket may have waiting; past that a query fails with `RATE_LIMITED`. */
  readonly maxQueuedQueries: number;
  /** Ids one `qd:sub` may name (RFC 0003 section 6). */
  readonly maxSubscribeIds: number;
  /**
   * A call's default time limit in milliseconds, after which it fails with
   * `TIMEOUT`. A v5 client waits this long plus 2 s for an answer, so a slow
   * call ends with the server's `TIMEOUT` rather than its own.
   */
  readonly callTimeoutMs: number;
  /** The socket's lane of subscription events. */
  readonly subscriptions: HelloSubscriptionLimits;
}

/**
 * `qd:hello`: the server's answer to a v5 handshake, sent once per
 * connection, after the socket's listeners are in place. It says who the
 * socket acts for, so a client knows its user without another call.
 */
export interface HelloFrame {
  /** The protocol the server speaks. */
  readonly protocol: typeof PROTOCOL_VERSION;
  /** The server package's version. */
  readonly server: string;
  /** What a client must stay within. */
  readonly limits: HelloLimits;
  /** Names of optional server features that are on. Informational only. */
  readonly features: readonly string[];
  /** The user the socket acts for, or `null` when it is anonymous. */
  readonly userId: string | null;
  /**
   * The principal's service-wide grants when the socket connected, by
   * service name: `{ taskService: "Admin" }`. Empty for an anonymous socket
   * or a principal without grants. Later changes arrive as `qd:access`.
   */
  readonly serviceAccess: Readonly<Record<string, AccessLevel>>;
}
