// Socket helpers for tests, ported from 4.1 (`legacy-src/server/testing.ts:135-180`).
// 4.1's `emitWithAck` unwrapped the 4.x `{ success, data }` reply; this one
// resolves with the acknowledgement as the server sent it, since a v5 reply
// (`{ ok, d }`) and a 4.x one now both exist. For typed v5 calls use
// `connect(principal).call` from `createTestApp`.

import { io, type Socket } from "socket.io-client";
import type { CallReply } from "../protocol/envelope";
import { fromWire } from "../protocol/errors";
import { PROTOCOL_VERSION, type HelloFrame } from "../protocol/version";
import { lazyMembers, type CallOptions } from "../server/caller";
import { QUICKDRAW_VERSION } from "../version";

/** A Socket.IO client socket. */
export type ClientSocket = Socket;

/**
 * Emits `event` with `payload` and resolves with the server's acknowledgement.
 * Without a payload none is sent (Socket.IO would send `undefined` as `null`).
 * Rejects when no acknowledgement arrives within `timeoutMs`.
 */
export function emitWithAck<Reply = unknown>(
  socket: Socket,
  event: string,
  payload?: unknown,
  timeoutMs = 5000,
): Promise<Reply> {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      reject(new Error(`Timeout waiting for ${event}`));
    }, timeoutMs);
    const ack = (reply: Reply): void => {
      clearTimeout(timeout);
      resolve(reply);
    };
    if (payload === undefined) {
      socket.emit(event, ack);
    } else {
      socket.emit(event, payload, ack);
    }
  });
}

/** Resolves with the payload of the next `event` the socket receives; rejects after `timeoutMs`. */
export function waitForEvent<T = unknown>(
  socket: Socket,
  event: string,
  timeoutMs = 5000,
): Promise<T> {
  return new Promise((resolve, reject) => {
    let timeout: ReturnType<typeof setTimeout> | undefined;
    const handler = (data: T): void => {
      clearTimeout(timeout);
      resolve(data);
    };
    timeout = setTimeout(() => {
      socket.off(event, handler);
      reject(new Error(`Timeout waiting for event ${event}`));
    }, timeoutMs);
    socket.once(event, handler);
  });
}

interface Envelope {
  readonly id: number;
  readonly s: string;
  readonly m: string;
  readonly i?: unknown;
}

async function callOverSocket(
  socket: Socket,
  envelope: Envelope,
  signal: AbortSignal | undefined,
  timeoutMs: number,
): Promise<unknown> {
  const cancel = (): void => {
    socket.emit("qd:cancel", { id: envelope.id });
  };
  const pending = emitWithAck<CallReply>(socket, "qd:call", envelope, timeoutMs);
  if (signal?.aborted === true) {
    cancel();
  } else {
    signal?.addEventListener("abort", cancel, { once: true });
  }
  try {
    const reply = await pending;
    if (!reply.ok) {
      throw fromWire(reply.e);
    }
    return reply.nm === true ? undefined : reply.d;
  } finally {
    signal?.removeEventListener("abort", cancel);
  }
}

/**
 * A caller like `dispatcher.caller(principal)` whose calls travel over
 * `socket` as `qd:call` frames: `call.taskService.get(input)` resolves with
 * the data or rejects with the call's `QuickdrawError`. An aborted `signal`
 * sends `qd:cancel`.
 */
export function socketCaller(socket: Socket, timeoutMs: number): object {
  let nextId = 0;
  return lazyMembers((service) =>
    lazyMembers((method) => (input?: unknown, options?: CallOptions) => {
      const id = nextId;
      nextId += 1;
      const envelope =
        input === undefined
          ? { id, s: service, m: method }
          : { id, s: service, m: method, i: input };
      return callOverSocket(socket, envelope, options?.signal, timeoutMs);
    }),
  );
}

/** Connects and resolves with the server's hello, or rejects with the `connect_error`. */
function handshake(socket: Socket, timeoutMs: number): Promise<HelloFrame> {
  return new Promise((resolve, reject) => {
    const finish = (error: Error | undefined, frame?: HelloFrame): void => {
      clearTimeout(timer);
      socket.off("qd:hello", onHello);
      socket.off("connect_error", onError);
      if (frame === undefined) {
        reject(error);
      } else {
        resolve(frame);
      }
    };
    const onHello = (frame: HelloFrame): void => finish(undefined, frame);
    const onError = (error: Error): void => finish(error);
    const timer = setTimeout(() => {
      finish(new Error(`No qd:hello within ${timeoutMs} ms`));
    }, timeoutMs);
    socket.once("qd:hello", onHello);
    socket.once("connect_error", onError);
    socket.connect();
  });
}

/**
 * Opens a v5 socket to `url` that never reconnects, with `auth` plus the v5
 * handshake (`auth.qd`), and resolves once the server said hello. A refused
 * connection rejects with the `connect_error` and leaves the socket closed.
 */
export async function connectV5(
  url: string,
  auth: Readonly<Record<string, unknown>>,
  timeoutMs: number,
): Promise<{ readonly socket: Socket; readonly hello: HelloFrame }> {
  const socket = io(url, {
    forceNew: true,
    reconnection: false,
    autoConnect: false,
    transports: ["websocket"],
    auth: { ...auth, qd: { protocol: PROTOCOL_VERSION, client: QUICKDRAW_VERSION } },
  });
  try {
    return { socket, hello: await handshake(socket, timeoutMs) };
  } catch (error) {
    socket.disconnect();
    throw error;
  }
}
