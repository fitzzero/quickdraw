// Reading the collection frames a client sends (RFC 0003 sections 7.3 and
// 8.2), which `envelope.ts` defines: `qd:col:sub { s, c, scope, since?,
// limit?, cursor? }` and `qd:col:unsub { s, c, scope }`. A malformed frame is
// `VALIDATION`, naming the field; an unknown service or collection is
// `NOT_FOUND`.

import type { Failure, Ok } from "../../protocol/envelope";
import { QuickdrawError, toWire } from "../../protocol/errors";
import { liveService } from "../emit/hub";
import { unreadable } from "../transports/ack";
import type { QuickdrawServerSocket } from "../transports/types";
import type { BoundCollection, CollectionHub } from "./bind";
import { roomOf, type ScopeSubscription } from "./scopes";
import type { ScopeRequest } from "./subscribe";

type UnknownRecord = Readonly<Record<string, unknown>>;

type ScopeRef = Pick<ScopeSubscription, "s" | "c" | "scope">;

function isRecord(value: unknown): value is UnknownRecord {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isName(value: unknown): value is string {
  return typeof value === "string" && value.length > 0;
}

/** Reads `{ s, c, scope }`, or throws `VALIDATION`. */
function readRef(frame: unknown, event: string): ScopeRef & { readonly frame: UnknownRecord } {
  if (!isRecord(frame) || !isName(frame.s) || !isName(frame.c) || !isName(frame.scope)) {
    throw unreadable(`A ${event} frame needs { s, c, scope } with each a non-empty string`);
  }
  return { s: frame.s, c: frame.c, scope: frame.scope, frame };
}

/** Reads a `qd:col:sub` frame, or throws `VALIDATION`. */
export function readSubscribe(value: unknown): ScopeRequest {
  const { s, c, scope, frame } = readRef(value, "qd:col:sub");
  const { since, limit, cursor } = frame;
  if (since !== undefined && (typeof since !== "number" || !Number.isFinite(since))) {
    throw unreadable("since must be the revision the client holds the scope at", ["since"]);
  }
  if (
    limit !== undefined &&
    (typeof limit !== "number" || !Number.isSafeInteger(limit) || limit < 1)
  ) {
    throw unreadable("limit must be a positive whole number", ["limit"]);
  }
  if (cursor !== undefined && !isName(cursor)) {
    throw unreadable("cursor must be the cursor of a page this collection sent", ["cursor"]);
  }
  if (since !== undefined && cursor !== undefined) {
    throw unreadable(
      "A qd:col:sub frame resumes (since) or reads a later page (cursor), not both",
      ["cursor"],
    );
  }
  return {
    s,
    c,
    scope,
    ...(since === undefined ? {} : { since }),
    ...(limit === undefined ? {} : { limit }),
    ...(cursor === undefined ? {} : { cursor }),
  };
}

/** The collection a frame names, or `NOT_FOUND`. */
export function collectionOf(hub: CollectionHub, service: string, name: string): BoundCollection {
  liveService(hub, service);
  const collection = hub.collections.routes.find(service, name);
  if (collection === undefined) {
    throw new QuickdrawError("NOT_FOUND", `${service} has no collection "${name}"`);
  }
  return collection;
}

/** Serves `qd:col:unsub`: the socket leaves the scope, and a subscribe still being made will not join it. */
export function unsubscribeScope(
  hub: CollectionHub,
  socket: QuickdrawServerSocket,
  value: unknown,
): Ok | Failure {
  try {
    const ref = readRef(value, "qd:col:unsub");
    hub.collections.scopes.unsubscribe(socket, roomOf(ref));
    return { ok: true };
  } catch (error) {
    if (error instanceof QuickdrawError) {
      return { ok: false, e: toWire(error) };
    }
    throw error;
  }
}
