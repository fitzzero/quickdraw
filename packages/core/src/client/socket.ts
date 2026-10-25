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
// Socket.IO also buffers what is emitted while its socket still reads
// connected but the engine under it is gone: the server's ping is overdue
// (a timer the browser throttled, a device asleep), and engine.io closes
// the engine a microtask after an emit notices. A call it buffered then is
// taken back and held the same way (`call.ts`), and the socket's drop fails
// whatever else the buffer still holds (`failBuffered`, `connection.ts`).
// So nothing quickdraw emits on one socket goes out on the next before its
// hello: while a socket is down, quickdraw holds its calls, drops its
// channel messages and sends nothing else. What an app emits on the socket
// itself while it is down still waits in that buffer for the next connect,
// which is why apps never emit on it (`no-raw-socket`). Socket.IO's own
// `retries`, which would send an acknowledged emit again on the next
// connect, from a queue of their own, are refused (`createSocket`).
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

/**
 * Socket.IO client options, `io(url, options)`, but `retries`, which
 * `createSocket` refuses.
 */
export type SocketClientOptions = Partial<Omit<ManagerOptions & SocketOptions, "retries">>;

/** The connection options the socket is made from. */
export interface SocketSettings {
  readonly url: string;
  readonly socketOptions?: SocketClientOptions;
  readonly transports?: SocketClientOptions["transports"];
  readonly binary?: boolean;
}

/**
 * Throws when `options` turn on Socket.IO's own retries: a `retries` that is
 * truthy, as Socket.IO reads it (`0`, or none, leaves them off). Socket.IO
 * would keep each emit it acknowledges in a queue of its own and send it
 * again at the next connect, before that socket's hello, as whoever its
 * credentials then name, and after a timeout, while the server may still be
 * running it.
 */
function refuseRetries(options: SocketClientOptions | undefined): void {
  const { retries } = (options ?? {}) as { readonly retries?: unknown };
  if (retries) {
    throw new TypeError(
      "createQuickdrawConnection: socketOptions.retries is not supported. Socket.IO would send an " +
        "unanswered call again on the next connect, before that socket's qd:hello says whom it " +
        "speaks for, and after a timeout, while the server may still be running it. Leave it out: " +
        "quickdraw retries only the calls that are safe to retry.",
    );
  }
}

/**
 * Creates the socket, unconnected. `credentials` is read on every connect,
 * so new credentials take effect on the next one; the handshake adds
 * `qd: { protocol: 5, client }` to them. Throws a `TypeError` for
 * `socketOptions.retries` (`refuseRetries`).
 */
export function createSocket(
  settings: SocketSettings,
  credentials: () => Readonly<Record<string, unknown>>,
): QuickdrawSocket {
  refuseRetries(settings.socketOptions);
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

/** A packet in Socket.IO's send buffer. */
export type BufferedPacket = QuickdrawSocket["sendBuffer"][number];

/**
 * Takes the packets `which` picks (every one, by default) out of Socket.IO's
 * send buffer, and fails them with `error`: an acknowledgement that takes an
 * error first is told it, which also ends its time limit, and any other is
 * dropped. Returns how many it took. Socket.IO sends that buffer on the next
 * connect, before that socket's hello and whatever credentials it carries,
 * so a call made as one user would run as the next. Calls are held
 * (`CallHold`) or taken back (`call.ts`), not left there: this is for
 * anything else emitted on the socket.
 */
export function failBuffered(
  socket: QuickdrawSocket,
  error: Error,
  which: (packet: BufferedPacket) => boolean = () => true,
): number {
  const taken: BufferedPacket[] = [];
  const kept: BufferedPacket[] = [];
  for (const packet of socket.sendBuffer) {
    (which(packet) ? taken : kept).push(packet);
  }
  if (taken.length === 0) {
    return 0;
  }
  socket.sendBuffer.splice(0, socket.sendBuffer.length, ...kept);
  const { acks } = socket as unknown as { readonly acks: Record<string, Ack | undefined> };
  for (const packet of taken) {
    const id = packet.id === undefined ? undefined : String(packet.id);
    const ack = id === undefined ? undefined : acks[id];
    if (id !== undefined && ack !== undefined) {
      Reflect.deleteProperty(acks, id);
      if (ack.withError === true) {
        ack.call(socket, error);
      }
    }
  }
  return taken.length;
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
  /**
   * True from the socket's hello until it connects again: a call may go out
   * on it while it is connected too (a dropped socket is not).
   */
  readonly confirmed: boolean;
  /** How many calls it holds. */
  readonly size: number;
  /** The socket connected: a new socket, whose own hello is awaited. */
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
