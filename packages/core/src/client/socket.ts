// The Socket.IO socket of a client connection (RFC 0003 sections 8.1 and
// 8.4): created unconnected with the connection's options, typed with the v5
// frames, encoding with the JSON-only parser unless the server sends binary,
// and sending the v5 handshake beside the app's credentials on every
// connect. Split from `connection.ts`, which owns the socket's state.
//
// React-free.

import { io, type ManagerOptions, type Socket, type SocketOptions } from "socket.io-client";
import type { ClientToServerEvents, ServerToClientEvents } from "../protocol/envelope";
import { createJsonParser } from "../protocol/parser";
import { PROTOCOL_VERSION } from "../protocol/version";
import { QUICKDRAW_VERSION } from "../version";

/** The client's Socket.IO socket, typed with the v5 frames. */
export type QuickdrawSocket = Socket<ServerToClientEvents, ClientToServerEvents>;

/** Socket.IO client options: `io(url, options)`. */
export type SocketClientOptions = Partial<ManagerOptions & SocketOptions>;

/** The connection options the socket is made from. */
export interface SocketSettings {
  readonly url: string;
  readonly socketOptions?: SocketClientOptions;
  readonly transports?: SocketClientOptions["transports"];
  readonly binary?: boolean;
}

/**
 * Creates the socket, unconnected. `credentials` is read on every connect,
 * so new credentials take effect on the next one; the handshake adds
 * `qd: { protocol: 5, client }` to them.
 */
export function createSocket(
  settings: SocketSettings,
  credentials: () => Readonly<Record<string, unknown>>,
): QuickdrawSocket {
  return io(settings.url, {
    forceNew: true,
    withCredentials: true,
    transports: ["websocket", "polling"],
    ...(settings.binary === true ? {} : { parser: createJsonParser() }),
    ...settings.socketOptions,
    ...(settings.transports === undefined ? {} : { transports: settings.transports }),
    autoConnect: false,
    auth: (send: (data: object) => void) => {
      send({ ...credentials(), qd: { protocol: PROTOCOL_VERSION, client: QUICKDRAW_VERSION } });
    },
  });
}
