// The protocol version and the connection handshake (RFC 0003 section 8.1).
// A v5 client connects with `auth: { token, qd: { protocol: 5, client } }`.
// The server answers with `qd:hello`, or refuses a client that names another
// protocol with `PROTOCOL_MISMATCH` in the `connect_error` data. A client that
// sends no `auth.qd` is a 4.x client, which only the legacy shim serves
// (section 8.5). There is no capability negotiation: the version decides.

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

/** The most ids one `qd:sub` may name (RFC 0003 section 6), as `qd:hello` announces it. */
export const MAX_SUBSCRIBE_IDS = 500;

/** The limits a server announces in `qd:hello`, so a client can stay inside them. */
export interface HelloLimits {
  /** Queries one socket may have running at once; more wait in a queue (RFC 0003 section 9). */
  readonly maxInFlightQueries: number;
  /** Queries one socket may have waiting; past that a query fails with `RATE_LIMITED`. */
  readonly maxQueuedQueries: number;
  /** Ids one `qd:sub` may name (RFC 0003 section 6). */
  readonly maxSubscribeIds: number;
  /** A call's default time limit in milliseconds, after which it fails with `TIMEOUT`. */
  readonly callTimeoutMs: number;
}

/** `qd:hello`: the server's answer to a v5 handshake, sent once per connection. */
export interface HelloFrame {
  readonly protocol: typeof PROTOCOL_VERSION;
  /** The server package's version. */
  readonly server: string;
  readonly limits: HelloLimits;
  /** Names of optional server features that are on. Informational only. */
  readonly features: readonly string[];
}
