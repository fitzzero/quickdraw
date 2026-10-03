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
// failed lookup or read is `INTERNAL`, logged. `qd:unsub` is checked the same
// way.
//
// No listener of the live data throws (`answer.ts`), and `qd:sub` runs in
// the socket's lane of subscription work (`lane.ts`).

import { CLIENT_EVENTS } from "../../contract/names";
import type { EntitySubscribeReply, Ok, Revision } from "../../protocol/envelope";
import { QuickdrawError } from "../../protocol/errors";
import { MAX_SUBSCRIBE_IDS } from "../../protocol/version";
import { unreadable } from "../transports/ack";
import type { QuickdrawServerSocket, SocketContext } from "../transports/types";
import { answerEvent, answerNow, onDisconnect } from "./answer";
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

/** Reads the `{ s, ids }` of a `qd:sub` or `qd:unsub` frame, or throws `VALIDATION`. */
function readIds(
  frame: unknown,
  event: string,
  shape: string,
): { readonly s: string; readonly ids: readonly string[]; readonly frame: UnknownRecord } {
  if (!isRecord(frame) || typeof frame.s !== "string" || frame.s === "" || !isIdList(frame.ids)) {
    throw unreadable(`A ${event} frame needs ${shape} with ids a list of row ids`);
  }
  if (frame.ids.length > MAX_SUBSCRIBE_IDS) {
    throw unreadable(`A ${event} frame names at most ${MAX_SUBSCRIBE_IDS} ids`, ["ids"]);
  }
  return { s: frame.s, ids: frame.ids, frame };
}

/** Reads a `qd:sub` frame, or throws `VALIDATION`. */
function readSubscribe(value: unknown): SubscribeRequest {
  const { s, ids, frame } = readIds(value, CLIENT_EVENTS.sub, "{ s, ids, revs? }");
  const { revs } = frame;
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
}

/** Serves `qd:unsub`: checked as `qd:sub` is, then each row's subscription ends. */
function onUnsubscribe(hub: Hub, socket: QuickdrawServerSocket, frame: unknown): Ok {
  const { s, ids } = readIds(frame, CLIENT_EVENTS.unsub, "{ s, ids }");
  liveService(hub, s);
  if (socket.data.principal === null) {
    throw new QuickdrawError("UNAUTHENTICATED", "Authentication required");
  }
  for (const id of ids) {
    hub.subscriptions.unsubscribe(socket, s, id);
  }
  return { ok: true };
}

/**
 * The socket extension (`transports/socketio.ts`) that serves `qd:sub` and
 * `qd:unsub` for one dispatcher's services.
 */
export function entitySubscriptions(
  hub: Hub,
): (socket: QuickdrawServerSocket, context: SocketContext) => void {
  return (socket, context) => {
    answerEvent(socket, context, CLIENT_EVENTS.sub, (frame) => onSubscribe(hub, socket, frame));
    socket.on(CLIENT_EVENTS.unsub, (frame: unknown, ack: unknown) => {
      answerNow(socket, context, CLIENT_EVENTS.unsub, ack, () => onUnsubscribe(hub, socket, frame));
    });
    onDisconnect(socket, context, () => {
      hub.subscriptions.drop(socket);
    });
  };
}
