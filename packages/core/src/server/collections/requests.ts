// Reading the collection frames a client sends (RFC 0003 sections 7.3, 7.4
// and 8.2), which `envelope.ts` defines: `qd:col:sub { s, c, scope, since?,
// limit?, cursor? }`, `qd:col:unsub { s, c, scope }` and `qd:col:items { s,
// c, scope, ids }`. A malformed frame is `VALIDATION`, naming the field; an
// unknown service or collection is `NOT_FOUND`; an anonymous socket is
// `UNAUTHENTICATED`.
//
// `qd:col:items` serves a socket that subscribed to the scope already: its
// subscription is the authorization, kept current by revocation, so it reads
// no access and costs one statement (two for a `via` scope). A socket that
// has not subscribed is `FORBIDDEN`, and more than 200 ids are `VALIDATION`,
// as more than 500 are for `qd:sub`.

import type { CollectionItemsReply, Ok } from "../../protocol/envelope";
import { QuickdrawError } from "../../protocol/errors";
import { liveService } from "../emit/hub";
import type { StorageAdapter } from "../storage";
import { unreadable } from "../transports/ack";
import type { QuickdrawServerSocket } from "../transports/types";
import type { BoundCollection, CollectionHub } from "./bind";
import { MAX_ITEM_IDS, readItemsById } from "./items";
import { roomOf, type ScopeSubscription } from "./scopes";
import type { ScopeRequest } from "./subscribe";

type UnknownRecord = Readonly<Record<string, unknown>>;

type ScopeRef = Pick<ScopeSubscription, "s" | "c" | "scope">;

/** A `qd:col:items` frame, read. */
export interface ItemsRequest extends ScopeRef {
  readonly ids: readonly string[];
}

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

/** Reads a `qd:col:items` frame, or throws `VALIDATION`. */
export function readItemsRequest(value: unknown): ItemsRequest {
  const { s, c, scope, frame } = readRef(value, "qd:col:items");
  const { ids } = frame;
  if (!Array.isArray(ids) || !ids.every(isName)) {
    throw unreadable("ids must be a list of row ids", ["ids"]);
  }
  if (ids.length > MAX_ITEM_IDS) {
    throw unreadable(`A qd:col:items frame names at most ${MAX_ITEM_IDS} ids`, ["ids"]);
  }
  return { s, c, scope, ids };
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

/**
 * The collection a request names and the storage it is read through: the
 * checks every collection request makes first. Throws `NOT_FOUND` for an
 * unknown service or collection, `UNAUTHENTICATED` for an anonymous socket,
 * and `INTERNAL` when the dispatcher has no storage adapter.
 */
export function servedCollection(
  hub: CollectionHub,
  socket: QuickdrawServerSocket,
  ref: Pick<ScopeRef, "s" | "c">,
): { readonly collection: BoundCollection; readonly storage: StorageAdapter } {
  const collection = collectionOf(hub, ref.s, ref.c);
  if (socket.data.principal === null) {
    throw new QuickdrawError("UNAUTHENTICATED", "Authentication required");
  }
  if (hub.storage === undefined) {
    throw new QuickdrawError(
      "INTERNAL",
      "Collections read rows through the dispatcher's storage adapter: pass db as trackPrisma(prisma)",
    );
  }
  return { collection, storage: hub.storage };
}

/**
 * Serves one `qd:col:items`: the items of the requested ids that are members
 * of the scope, in request order. Throws what `servedCollection` throws, and
 * `FORBIDDEN` when the socket is not subscribed to the scope.
 */
export async function loadItems(
  hub: CollectionHub,
  socket: QuickdrawServerSocket,
  request: ItemsRequest,
): Promise<CollectionItemsReply> {
  const { collection, storage } = servedCollection(hub, socket, request);
  if (hub.collections.scopes.get(socket, roomOf(request)) === undefined) {
    throw new QuickdrawError(
      "FORBIDDEN",
      "qd:col:items needs the scope subscribed with qd:col:sub",
    );
  }
  return { ok: true, items: await readItemsById(storage, collection, request.scope, request.ids) };
}

/**
 * Serves `qd:col:unsub`: the socket leaves the scope, and a subscribe still
 * being made will not join it. Throws `VALIDATION` for a malformed frame and
 * `NOT_FOUND` for an unknown service or collection.
 */
export function unsubscribeScope(
  hub: CollectionHub,
  socket: QuickdrawServerSocket,
  value: unknown,
): Ok {
  const ref = readRef(value, "qd:col:unsub");
  collectionOf(hub, ref.s, ref.c);
  hub.collections.scopes.unsubscribe(socket, roomOf(ref));
  return { ok: true };
}
