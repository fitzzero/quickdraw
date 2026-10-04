// The live frames of a connection, received once and routed by key (RFC 0003
// sections 8.3 and 12.5): one listener each for `qd:e`, `qd:c`,
// `qd:revoked`, `qd:stream`, `qd:event` and `qd:presence` on the socket,
// however many rows, scopes, feeds and handlers are held. The entity store
// routes an entity frame by `service` and `id`, the collection hub a
// collection frame by `service`, `collection` and `scope`, the stream store a
// stream frame by `s`, `stream` and `scope`, the event bus an event by
// service and event, and the presence store a presence frame by room. 4.1
// put one `socket.on` per subscribed entity, collection scope and room event
// name on the socket (`legacy-src/client/useSubscription.ts:106-129`,
// `legacy-src/client/useCollection.ts:260`,
// `legacy-src/client/useRoomEvents.ts:79-85`).
//
// React-free.

import { SERVER_EVENTS } from "../../contract/names";
import { isName, isRecord } from "../../protocol/guards";
import type { QuickdrawSocket } from "../connection";
import type { CollectionHub } from "./collections";
import type { EntityStore } from "./entityStore";
import type { EventBus } from "./events";
import type { PresenceStore } from "./presence";
import type { StreamStore } from "./streams";

/** Where frames go. */
export interface FrameRoutes {
  readonly entities: Pick<EntityStore, "receive" | "revoked">;
  readonly collections: Pick<CollectionHub, "receive" | "revoked">;
  readonly streams: Pick<StreamStore, "receive" | "revoked">;
  readonly events: Pick<EventBus, "receive">;
  readonly presence: Pick<PresenceStore, "receive">;
}

/** Routes a `qd:revoked` frame, checked: it came over the network. */
function routeRevoked(routes: FrameRoutes, frame: unknown): void {
  if (!isRecord(frame) || !isName(frame.s)) {
    return;
  }
  const reason = frame.reason === "anchor-deleted" ? "anchor-deleted" : "access";
  if (frame.kind === "entity" && isName(frame.id)) {
    routes.entities.revoked(frame.s, frame.id);
  } else if (frame.kind === "collection" && isName(frame.c) && isName(frame.scope)) {
    routes.collections.revoked(frame.s, frame.c, frame.scope, reason);
  } else if (
    frame.kind === "stream" &&
    isName(frame.stream) &&
    (frame.scope === undefined || isName(frame.scope))
  ) {
    routes.streams.revoked(frame.s, frame.stream, frame.scope);
  }
}

/** Puts one listener per live frame type on `socket`, routing each frame to `routes`. */
export function listenToFrames(socket: QuickdrawSocket, routes: FrameRoutes): void {
  socket.on(SERVER_EVENTS.entity, (frame: unknown) => {
    routes.entities.receive(frame);
  });
  socket.on(SERVER_EVENTS.collection, (frame: unknown) => {
    routes.collections.receive(frame);
  });
  socket.on(SERVER_EVENTS.revoked, (frame: unknown) => {
    routeRevoked(routes, frame);
  });
  socket.on(SERVER_EVENTS.stream, (frame: unknown) => {
    routes.streams.receive(frame);
  });
  socket.on(SERVER_EVENTS.event, (frame: unknown) => {
    routes.events.receive(frame);
  });
  socket.on(SERVER_EVENTS.presence, (frame: unknown) => {
    routes.presence.receive(frame);
  });
}
