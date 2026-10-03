// What the socket transport keeps on each socket, the Socket.IO types that
// carry it, and what its listeners share.

import type { DefaultEventsMap, Server, Socket } from "socket.io";
import type { Logger } from "../../contract/logger";
import type { PROTOCOL_VERSION } from "../../protocol/version";
import type { Dispatcher } from "../dispatcher";
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
