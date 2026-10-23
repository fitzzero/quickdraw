// The public shape of a peer link (RFC 0003 section 12.5), shared by
// `createPeerLink` and the loopback double of `./testing`.
//
// React-free.

import type { PeerLabel } from "../../protocol/envelope";
import type { PeerClock } from "./clock";

export type { PeerLabel };

/**
 * Where a link is: `connecting` until a path carries it, `open` while one
 * does (`path` says which), `closed` for good (`closeReason` says why).
 */
export type PeerLinkState = "connecting" | "open" | "closed";

/** What carries an open link: WebRTC data channels between the two clients, or the server's relay. */
export type PeerPath = "direct" | "relay";

/**
 * Why a link closed:
 *
 * - `closed`: this side's `close()`;
 * - `bye`: the peer closed it, left the room or disconnected (the server
 *   says so for a peer that left);
 * - `left`: this socket left the link's room, or was taken out of it;
 * - `disconnected`: this side's socket disconnected (a link lives as long
 *   as the socket it started on), or the connection was closed;
 * - `timeout`: no path opened within 15 seconds;
 * - `lost`: nothing was heard from the peer for 8 seconds, or the direct
 *   path of a link that may not use the relay (`relay: "never"`) dropped
 *   after it opened;
 * - `failed`: the direct path failed and the link may not use the relay
 *   (`relay: "never"`);
 * - `refused`: the server refused a signal (the peer is not in the room,
 *   this socket signals too many peers, ...);
 * - `unsupported`: the server serves no peer links (its hello lists no
 *   `"peer"`), or the link may use neither WebRTC (absent here) nor the
 *   relay.
 */
export type PeerCloseReason =
  | "closed"
  | "bye"
  | "left"
  | "disconnected"
  | "timeout"
  | "lost"
  | "failed"
  | "refused"
  | "unsupported";

/** What a link counted. */
export interface PeerLinkStats {
  /** App messages a path took: under a lag (`setLag`), each as it goes. */
  readonly sent: number;
  /** App messages received. */
  readonly received: number;
  /**
   * App messages `send` dropped: sent while the link was not open, a `fast`
   * message while the data channel was backed up, or one over the relay's
   * limits. Under a lag, also a held `fast` message its path refused as it
   * came due, and a `rel` one sent while a held `rel` message waits for its
   * path.
   */
  readonly dropped: number;
  /**
   * App messages the lag lost (`setLag`'s `loss`), sent or received: `fast`
   * ones alone, and never counted in `dropped`.
   */
  readonly simulatedLoss: number;
}

/** A link's simulated network, as `setLag` set it. */
export interface PeerLinkLag {
  /** How long each message waits, each way, in milliseconds. */
  readonly ms: number;
  /** Up to this many milliseconds more, at random, per message. */
  readonly jitter: number;
  /** The share of `fast` messages lost, each way, from 0 to 1. */
  readonly loss: number;
}

/** What `setLag` takes: each part defaults to 0. */
export interface PeerLinkLagOptions {
  /** How long each message waits, each way, in milliseconds. */
  readonly ms?: number;
  /** Up to this many milliseconds more, at random, per message. */
  readonly jitter?: number;
  /** The share of `fast` messages lost, each way, from 0 to 1. `rel` ones never are. */
  readonly loss?: number;
  /** Random numbers from 0 to 1, for jitter and loss. Default `Math.random`; pass a seeded one to repeat a run. */
  readonly random?: () => number;
}

/** A link's events and their listeners' arguments. */
export interface PeerLinkEvents {
  /** An app message from the peer, on `label`. */
  message: (data: unknown, label: PeerLabel) => void;
  /** The link opened, on `path`: once. */
  open: (path: PeerPath) => void;
  /** The link's state or path changed. */
  state: (state: PeerLinkState, path: PeerPath | undefined) => void;
  /** The link closed, for good: once. */
  close: (reason: PeerCloseReason) => void;
}

/**
 * A link to another socket of an app room: two channels, `rel` (ordered,
 * reliable) and `fast` (unordered, never retransmitted), over WebRTC data
 * channels or, when those cannot form, the server's relay, with the same
 * behaviour either way. Messages are JSON values.
 */
export interface PeerLink {
  /** The app room the link belongs to. */
  readonly room: string;
  /** The peer's socket id. */
  readonly peer: string;
  /** The peer's user, as the server named it in the peer's first signal; `undefined` until then. */
  readonly userId: string | undefined;
  readonly state: PeerLinkState;
  /** What carries the link while it is open. */
  readonly path: PeerPath | undefined;
  /** Why the link closed, once it has. */
  readonly closeReason: PeerCloseReason | undefined;
  /**
   * Sends `data` (any JSON value) on `label`. Returns false when it was
   * dropped: the link is not open, `fast` is backed up, or the relay's rate
   * is spent (`stats.dropped` counts it). `rel` delivers in order while the
   * path holds; a path change (the direct path failed, the relay took over)
   * may lose `rel` messages in flight, and emits `state`. Under a lag
   * (`setLag`) it returns true for a message it holds. Throws a
   * `RangeError` for a message over `limits.peers.maxMessageBytes`.
   */
  send(label: PeerLabel, data: unknown): boolean;
  /** Calls `listener` on `event`; returns its removal. */
  on<E extends keyof PeerLinkEvents>(event: E, listener: PeerLinkEvents[E]): () => void;
  /** The peer's clock, read from pings the link sends on `fast`. */
  readonly clock: PeerClock;
  /** What the link counted. */
  readonly stats: PeerLinkStats;
  /**
   * Simulates a bad network on this link, both ways and on either path, for
   * a test, a bench or a host that gives itself its peers' lag: each
   * message waits `ms` plus up to `jitter` milliseconds, and a `fast` one
   * is lost with probability `loss` (`stats.simulatedLoss` counts the
   * app's). `rel` messages are never lost and keep their order; one its
   * path refuses as it comes due goes again a little later. The clock's
   * pings wait too, so `clock.rtt` reads the lagged round trip. A new lag
   * leaves what is held on its time; `null` (or all zeros) ends it, and
   * what is held goes on the next task, in order. Throws a `TypeError` for
   * a part out of range. Does nothing once the link is closed.
   */
  setLag(lag: PeerLinkLagOptions | null): void;
  /** The lag `setLag` set; `null` for none. */
  readonly lag: PeerLinkLag | null;
  /** Closes the link and tells the peer. Does nothing once it is closed. */
  close(): void;
}
