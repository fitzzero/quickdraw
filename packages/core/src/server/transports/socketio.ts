// The Socket.IO transport (RFC 0003 sections 8 and 10). A v5 socket gets a
// fixed set of listeners, whatever the number of services and methods:
// `qd:call` and `qd:cancel` here, plus one per event from each registered
// `SocketExtension`. 4.1 registered one listener per method, and five more per
// service, on every socket (4.1 `src/server/ServiceRegistry.ts:118-136`).
//
// A call becomes one `DispatchRequest`: the connection is the socket, so its
// queries share the socket's concurrency lane; `qd:cancel` and a disconnect
// abort the call's signal; the reply goes out through the acknowledgement,
// written from a shared run's encoded copy when there is one, and its size
// comes back from the parser.

import { CLIENT_EVENTS, SERVER_EVENTS, userRoom } from "../../contract/names";
import { isCallEnvelope, isCancel, type CallId } from "../../protocol/envelope";
import { toWire } from "../../protocol/errors";
import type { HelloFrame } from "../../protocol/version";
import { describeError } from "../pipeline/metrics";
import type { Principal } from "../types";
import {
  acknowledge,
  callAcknowledgement,
  INTERNAL_FAILURE,
  unreadable,
  type Acknowledge,
} from "./ack";
import { attachLegacyShim, type LegacyCallers } from "./legacy";
import type { QuickdrawServerSocket, SocketContext } from "./types";

/**
 * Adds listeners to every v5 socket, after `qd:call` and `qd:cancel`. This is
 * the registration hook for the entity, collection, watch, stream and channel
 * events that later packs serve: an extension registers one listener per
 * event, never one per method or service, and routes by the frame's fields.
 */
export type SocketExtension = (socket: QuickdrawServerSocket, context: SocketContext) => void;

/** The part of `qd:hello` every socket of a server shares: all but who the socket acts for. */
export type ServerHello = Omit<HelloFrame, "userId" | "serviceAccess">;

/** The connection handler's settings. */
export interface ConnectionSettings extends SocketContext {
  /**
   * Sent to every v5 socket once its listeners are in place, with the
   * socket's user id and service grants added.
   */
  readonly hello: ServerHello;
  readonly extensions: readonly SocketExtension[];
  /** The 4.x callers already logged, shared by every socket of the server. */
  readonly legacyCallers: LegacyCallers;
}

type Calls = Map<CallId, AbortController>;

const MALFORMED_CALL = "A qd:call frame needs { id, s, m, i?, v? } and an acknowledgement";

function reply(
  socket: QuickdrawServerSocket,
  context: SocketContext,
  ack: Acknowledge,
  message: unknown,
): number | undefined {
  return acknowledge(context.meter, ack, message, INTERNAL_FAILURE, (error) => {
    context.logger.error("A call's reply could not be encoded; it was answered with INTERNAL", {
      category: "quickdraw.socket",
      socketId: socket.id,
      error: describeError(error),
    });
  });
}

function startCall(
  socket: QuickdrawServerSocket,
  context: SocketContext,
  calls: Calls,
  envelope: unknown,
  ack: Acknowledge,
): void {
  if (!isCallEnvelope(envelope)) {
    reply(socket, context, ack, { ok: false, e: toWire(unreadable(MALFORMED_CALL)) });
    return;
  }
  const { id } = envelope;
  if (calls.has(id)) {
    const duplicate = unreadable(`Call ${id} is already in flight on this socket`, ["id"]);
    reply(socket, context, ack, { ok: false, e: toWire(duplicate) });
    return;
  }
  const controller = new AbortController();
  calls.set(id, controller);
  // Freed before the reply goes out, so the client may reuse the id at once.
  const release = (): void => {
    if (calls.get(id) === controller) {
      calls.delete(id);
    }
  };
  void context.dispatcher
    .call({
      service: envelope.s,
      method: envelope.m,
      input: envelope.i,
      principal: socket.data.principal,
      transport: "socket",
      connectionId: socket.id,
      signal: controller.signal,
      v: envelope.v,
      respond: (result, shared) => {
        release();
        return reply(socket, context, ack, callAcknowledgement(context.meter, result, shared));
      },
    })
    .then(release, (error: unknown) => {
      // The reply went out already; only a strict test app's warning gets here.
      release();
      context.logger.error("A call failed after its reply was sent", {
        category: "quickdraw.socket",
        socketId: socket.id,
        error: describeError(error),
      });
    });
}

/** Registers `qd:call` and `qd:cancel` on a v5 socket, and cancels its calls when it disconnects. */
export function attachCallListeners(socket: QuickdrawServerSocket, context: SocketContext): void {
  const calls: Calls = new Map();
  socket.on(CLIENT_EVENTS.call, (envelope: unknown, ack: unknown) => {
    if (typeof ack !== "function") {
      context.logger.debug("Ignored a qd:call sent without an acknowledgement", {
        category: "quickdraw.socket",
        socketId: socket.id,
      });
      return;
    }
    startCall(socket, context, calls, envelope, ack as Acknowledge);
  });
  socket.on(CLIENT_EVENTS.cancel, (frame: unknown) => {
    if (isCancel(frame)) {
      calls.get(frame.id)?.abort();
    }
  });
  socket.on("disconnect", () => {
    for (const controller of calls.values()) {
      controller.abort();
    }
    calls.clear();
  });
}

/**
 * The server's `connection` handler: joins the socket's user room, then
 * gives a v5 socket its listeners and `qd:hello`, or a 4.x socket the legacy
 * shim. Only sockets the handshake middleware admitted get here.
 */
export function onConnection(
  settings: ConnectionSettings,
): (socket: QuickdrawServerSocket) => void {
  return (socket) => {
    const { principal } = socket.data;
    if (principal !== null) {
      void socket.join(userRoom(principal.userId));
    }
    if (socket.data.protocol === "legacy") {
      attachLegacyShim(socket, settings, settings.legacyCallers);
      return;
    }
    attachCallListeners(socket, settings);
    for (const extension of settings.extensions) {
      extension(socket, settings);
    }
    socket.emit(SERVER_EVENTS.hello, helloFor(settings.hello, principal));
  };
}

/** The `qd:hello` of a socket acting for `principal`: the server's part, its user id and its grants. */
function helloFor(hello: ServerHello, principal: Principal | null): HelloFrame {
  return {
    ...hello,
    userId: principal?.userId ?? null,
    serviceAccess: principal?.serviceAccess ?? {},
  };
}
