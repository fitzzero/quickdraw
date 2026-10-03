// The live frames of a connection, received once and routed by key (RFC 0003
// section 8.3): one listener each for `qd:e`, `qd:c` and `qd:revoked` on the
// socket, however many rows and scopes are held. The entity store routes an
// entity frame by `service` and `id`, the collection hub a collection frame
// by `service`, `collection` and `scope`. 4.1 put one `socket.on` per
// subscribed entity and per collection scope on the socket
// (`legacy-src/client/useSubscription.ts:106-129`,
// `legacy-src/client/useCollection.ts:260`).
//
// React-free.

import { SERVER_EVENTS } from "../../contract/names";
import { isName, isRecord } from "../../protocol/guards";
import type { QuickdrawSocket } from "../connection";
import type { CollectionHub } from "./collections";
import type { EntityStore } from "./entityStore";

/** Where frames go. */
export interface FrameRoutes {
  readonly entities: Pick<EntityStore, "receive" | "revoked">;
  readonly collections: Pick<CollectionHub, "receive" | "revoked">;
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
}
