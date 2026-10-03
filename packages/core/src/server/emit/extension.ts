// The socket listeners of entity subscriptions (RFC 0003 sections 6 and 8.2):
// `qd:sub { s, ids, revs? }`, answered `{ ok: true, r }` with one result per
// id or `{ ok: false, e }` for the whole batch, and `qd:unsub { s, ids }`,
// optionally acknowledged. One listener per event on every v5 socket, routed
// by the frame's service, never one per service or row. The rate limiter
// does not count either event (`transports/middleware.ts`): a board mounting
// sixty rows would otherwise trip it.
//
// The whole batch fails when the frame is malformed or holds more than 500
// ids (`VALIDATION`), names an unknown service or one without rows
// (`NOT_FOUND`), or comes from an anonymous socket (`UNAUTHENTICATED`); a
// failed lookup or read is `INTERNAL`, logged.

import { CLIENT_EVENTS } from "../../contract/names";
import type { EntitySubscribeReply, Failure, Ok, Revision } from "../../protocol/envelope";
import { QuickdrawError, toWire } from "../../protocol/errors";
import { MAX_SUBSCRIBE_IDS } from "../../protocol/version";
import { toQuickdrawError } from "../pipeline/errors";
import { describeError } from "../pipeline/metrics";
import { acknowledge, INTERNAL_FAILURE, unreadable, type Acknowledge } from "../transports/ack";
import type { QuickdrawServerSocket, SocketContext } from "../transports/types";
import { liveService, type Hub } from "./hub";
import { subscribe, type SubscribeRequest } from "./subscribe";

type UnknownRecord = Readonly<Record<string, unknown>>;

function isRecord(value: unknown): value is UnknownRecord {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isIdList(value: unknown): value is readonly string[] {
  return Array.isArray(value) && value.every((id) => typeof id === "string" && id.length > 0);
}

function isHeld(value: unknown): value is Revision | null {
  return value === null || (typeof value === "number" && Number.isFinite(value));
}

/** Reads a `qd:sub` frame, or throws `VALIDATION`. */
function readSubscribe(frame: unknown): SubscribeRequest {
  if (!isRecord(frame) || typeof frame.s !== "string" || frame.s === "" || !isIdList(frame.ids)) {
    throw unreadable("A qd:sub frame needs { s, ids, revs? } with ids a list of row ids");
  }
  const { s, ids, revs } = frame;
  if (ids.length > MAX_SUBSCRIBE_IDS) {
    throw unreadable(`A qd:sub frame names at most ${MAX_SUBSCRIBE_IDS} ids`, ["ids"]);
  }
  const listed = revs === undefined || (Array.isArray(revs) && revs.length === ids.length);
  if (!listed || (revs !== undefined && !revs.every(isHeld))) {
    throw unreadable("revs must hold a revision or null for each id, by position", ["revs"]);
  }
  const held = new Map<string, Revision>();
  ids.forEach((id, index) => {
    const rev: unknown = revs?.[index];
    if (typeof rev === "number") {
      held.set(id, rev);
    }
  });
  return { s, ids, held };
}

async function onSubscribe(
  hub: Hub,
  socket: QuickdrawServerSocket,
  frame: unknown,
): Promise<EntitySubscribeReply> {
  try {
    const request = readSubscribe(frame);
    const target = liveService(hub, request.s);
    if (socket.data.principal === null) {
      throw new QuickdrawError("UNAUTHENTICATED", "Authentication required");
    }
    if (hub.storage === undefined) {
      throw new QuickdrawError(
        "INTERNAL",
        "Entity subscriptions read rows through the dispatcher's storage adapter: pass db as trackPrisma(prisma)",
      );
    }
    return { ok: true, r: await subscribe(hub, socket, target, request) };
  } catch (error) {
    const failure = toQuickdrawError(error);
    if (failure.code === "INTERNAL") {
      hub.logger.error("A qd:sub batch failed", {
        category: "quickdraw.socket",
        socketId: socket.id,
        error: describeError(failure.cause ?? failure),
      });
    }
    return { ok: false, e: toWire(failure) };
  }
}

function onUnsubscribe(hub: Hub, socket: QuickdrawServerSocket, frame: unknown): Ok | Failure {
  if (!isRecord(frame) || typeof frame.s !== "string" || !isIdList(frame.ids)) {
    return { ok: false, e: toWire(unreadable("A qd:unsub frame needs { s, ids }")) };
  }
  for (const id of frame.ids) {
    hub.subscriptions.unsubscribe(socket, frame.s, id);
  }
  return { ok: true };
}

/** Acknowledges a subscription event, when the client asked for an acknowledgement. Never throws. */
export function reply(
  socket: QuickdrawServerSocket,
  context: SocketContext,
  ack: unknown,
  message: unknown,
): void {
  if (typeof ack !== "function") {
    return;
  }
  acknowledge(context.meter, ack as Acknowledge, message, INTERNAL_FAILURE, (error) => {
    context.logger.error(
      "A subscription reply could not be encoded; it was answered with INTERNAL",
      {
        category: "quickdraw.socket",
        socketId: socket.id,
        error: describeError(error),
      },
    );
  });
}

/**
 * The socket extension (`transports/socketio.ts`) that serves `qd:sub` and
 * `qd:unsub` for one dispatcher's services.
 */
export function entitySubscriptions(
  hub: Hub,
): (socket: QuickdrawServerSocket, context: SocketContext) => void {
  return (socket, context) => {
    socket.on(CLIENT_EVENTS.sub, (frame: unknown, ack: unknown) => {
      if (typeof ack !== "function") {
        context.logger.debug("Ignored a qd:sub sent without an acknowledgement", {
          category: "quickdraw.socket",
          socketId: socket.id,
        });
        return;
      }
      void onSubscribe(hub, socket, frame).then((answer) => {
        reply(socket, context, ack, answer);
      });
    });
    socket.on(CLIENT_EVENTS.unsub, (frame: unknown, ack: unknown) => {
      reply(socket, context, ack, onUnsubscribe(hub, socket, frame));
    });
    socket.on("disconnect", () => {
      hub.subscriptions.drop(socket);
    });
  };
}
