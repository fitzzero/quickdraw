// What the socket transport keeps on each socket, the Socket.IO types that
// carry it, and what its listeners share.

import type { DefaultEventsMap, Server, Socket } from "socket.io";
import type { Logger } from "../../contract/logger";
import type { PROTOCOL_VERSION } from "../../protocol/version";
import type { ScopeSubscriptions } from "../collections/scopes";
import type { Dispatcher } from "../dispatcher";
import type { EntitySubscriptions } from "../emit/subscriptions";
import type { TopicWatches } from "../topicIndex";
import type { Principal } from "../types";
import type { ReplyMeter } from "./ack";

/** What a quickdraw server keeps on each socket's `data`. */
export interface QuickdrawSocketData<P extends Principal = Principal> {
  /** Who the socket acts for, or `null` when anonymous. `access.refresh` replaces its grants. */
  principal: P | null;
  /** The protocol the client speaks: 5, or `"legacy"` for a 4.x client the shim serves. */
  protocol: typeof PROTOCOL_VERSION | "legacy";
  /** The v5 client package's version from its handshake; absent for a 4.x client. */
  client?: string;
  /**
   * The socket's entity subscriptions (`qd:sub`), by service and row id: the
   * level whose room it is in, and the rows that level is derived from
   * (RFC 0003 section 4.4). Plain data; the server keeps it.
   */
  entities?: EntitySubscriptions;
  /**
   * The socket's collection subscriptions (`qd:col:sub`), by room: the scope
   * and the rows its access is derived from (RFC 0003 sections 4.4 and 7).
   * Plain data; the server keeps it.
   */
  collections?: ScopeSubscriptions;
  /**
   * The change topics the socket watches (`qd:watch`), by room (RFC 0003
   * section 11.3). Plain data; the server keeps it.
   */
  topics?: TopicWatches;
}

/** The Socket.IO server `createServer` returns. Events are untyped, so apps may emit their own. */
export type QuickdrawIo<P extends Principal = Principal> = Server<
  DefaultEventsMap,
  DefaultEventsMap,
  DefaultEventsMap,
  QuickdrawSocketData<P>
>;

/** A socket of a quickdraw server, as its listeners see it. */
export type QuickdrawServerSocket<P extends Principal = Principal> = Socket<
  DefaultEventsMap,
  DefaultEventsMap,
  DefaultEventsMap,
  QuickdrawSocketData<P>
>;

/** What the socket transport's listeners share. */
export interface SocketContext {
  readonly dispatcher: Pick<Dispatcher, "call" | "registry" | "limits">;
  readonly logger: Logger;
  readonly meter: ReplyMeter;
}
