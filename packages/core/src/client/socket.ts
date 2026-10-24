// The Socket.IO socket of a client connection (RFC 0003 sections 8.1 and
// 8.4): created unconnected with the connection's options, typed with the v5
// frames, encoding with the JSON-only parser unless the server sends binary,
// and sending the v5 handshake beside the app's credentials on every
// connect. Split from `connection.ts`, which owns the socket's state.
//
// A socket's identity on the server is whoever its credentials named when
// it connected, which a session cookie can change without the app knowing,
// and its own `qd:hello` is the only word of it. So calls never wait in
// Socket.IO's send buffer, which the next connect flushes before that hello:
// from a socket's connect, or its drop, until its hello, the connection
// holds them itself (`CallHold`), and the hello lets each go, or refuses it,
// in the order they were made (`call.ts` decides which).
//
// React-free.

import { io, type ManagerOptions, type Socket, type SocketOptions } from "socket.io-client";
import type { ClientToServerEvents, ServerToClientEvents } from "../protocol/envelope";
import type { QuickdrawError } from "../protocol/errors";
import { createJsonParser } from "../protocol/parser";
import { PROTOCOL_VERSION, type HelloFrame } from "../protocol/version";
import { QUICKDRAW_VERSION } from "../version";
import { notifyEach } from "./watch";

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

/** An acknowledgement as Socket.IO keeps it: `withError` when it takes an error first (`timeout`). */
type Ack = ((...args: unknown[]) => void) & { readonly withError?: boolean };

/**
 * Fails every packet waiting in Socket.IO's send buffer with `error` and
 * empties the buffer. Socket.IO sends that buffer on the next connect,
 * whatever credentials the socket then carries, so a call made as one user
 * would run as the next. Calls are held (`CallHold`), not buffered: this is
 * for anything else an app emits on the socket itself.
 */
function failBuffered(socket: QuickdrawSocket, error: Error): void {
  const buffered = socket.sendBuffer.splice(0);
  const { acks } = socket as unknown as { readonly acks: Record<string, Ack | undefined> };
  for (const packet of buffered) {
    const id = packet.id === undefined ? undefined : String(packet.id);
    const ack = id === undefined ? undefined : acks[id];
    if (id !== undefined && ack !== undefined) {
      Reflect.deleteProperty(acks, id);
      if (ack.withError === true) {
        ack.call(socket, error);
      }
    }
  }
}

/** A call held until its socket's hello says whom the socket speaks for (`call.ts`). */
export interface HeldCall {
  /** The socket's hello arrived: the call goes out on it, or is refused. */
  confirmed(hello: HelloFrame): void;
  /** New credentials, `close`, or a session refused: the call fails with `error`, never sent. */
  failed(error: QuickdrawError): void;
}

/** The calls one connection holds until its socket is confirmed. */
export interface CallHold {
  /** True from the socket's hello until it connects again or drops: a call may go out on it. */
  readonly confirmed: boolean;
  /** How many calls it holds. */
  readonly size: number;
  /** The socket connected, or dropped: its hello is awaited again. */
  unconfirm(): void;
  /**
   * The socket's hello: confirms the socket, then tells every held call,
   * oldest first, before the hello does anything else, as Socket.IO sent its
   * buffer before telling anyone of the connect.
   */
  confirm(hello: HelloFrame): void;
  /** Holds `call` until the next hello; returns the function that lets it go. */
  hold(call: HeldCall): () => void;
  /** Fails every held call, and every packet in Socket.IO's send buffer, with `error`. */
  fail(error: QuickdrawError): void;
}

/** The hold of a connection over `socket`, unconfirmed until its first hello. */
export function createCallHold(socket: QuickdrawSocket): CallHold {
  const held = new Set<HeldCall>();
  let confirmed = false;
  const takeAll = (): HeldCall[] => {
    const calls = [...held];
    held.clear();
    return calls;
  };
  return Object.freeze({
    get confirmed(): boolean {
      return confirmed;
    },
    get size(): number {
      return held.size;
    },
    unconfirm(): void {
      confirmed = false;
    },
    confirm(hello: HelloFrame): void {
      confirmed = true;
      notifyEach(takeAll(), (call) => {
        call.confirmed(hello);
      });
    },
    hold(call: HeldCall): () => void {
      held.add(call);
      return () => {
        held.delete(call);
      };
    },
    fail(error: QuickdrawError): void {
      failBuffered(socket, error);
      notifyEach(takeAll(), (call) => {
        call.failed(error);
      });
    },
  });
}
