// Typed custom room events (RFC 0003 sections 8.3 and 15): `ctx.rooms.emit(room,
// contract, event, payload)` and `emitToUser`, which replace 4.1's
// `emitToRoom` and `emitToUserRoom` and the augmentable `QuickdrawEventMap`
// (`legacy-src/server/BaseService.ts:378-441`). The event must be one the
// contract declares, and its payload is checked against the event's schema
// before anything is sent: a payload that fails it throws `INTERNAL` (the
// app's bug, logged by the pipeline when a handler emits it) and no socket
// receives a frame. A checked payload goes out as given, as one `qd:event`
// frame, `[service, event, payload]`, to every socket in the room (on every
// node, through the adapter). Without a server there is nobody to send to.

import type { AnyContract } from "../../contract/defineContract";
import { SERVER_EVENTS, userRoom } from "../../contract/names";
import type { EventFrame } from "../../protocol/envelope";
import type { Hub } from "../emit/hub";
import type { ContextRooms } from "./types";
import { checkOutgoing } from "./validate";

type UnknownRecord = Readonly<Record<string, unknown>>;

function isRecord(value: unknown): value is UnknownRecord {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** The event's payload schema, or a `TypeError` for an event the contract does not declare. */
function payloadSchemaOf(contract: AnyContract, event: string): AnyContract["events"][string] {
  const events: unknown = isRecord(contract) ? contract.events : undefined;
  if (!isRecord(events) || typeof event !== "string" || !Object.hasOwn(events, event)) {
    const name = isRecord(contract) ? String(contract.name) : "the contract";
    throw new TypeError(`ctx.rooms.emit: ${name} declares no event "${String(event)}"`);
  }
  return events[event] as AnyContract["events"][string];
}

/** The emitting half of `ctx.rooms`, which needs no socket. */
export type RoomEvents = Pick<ContextRooms, "emit" | "emitToUser">;

/** `ctx.rooms.emit` and `emitToUser` for one dispatcher, sending through its server once one is attached. */
export function createRoomEvents(hub: Hub): RoomEvents {
  const send = (room: unknown, contract: AnyContract, event: string, payload: unknown): void => {
    if (typeof room !== "string" || room === "") {
      throw new TypeError("ctx.rooms.emit: room must be a non-empty string");
    }
    const def = payloadSchemaOf(contract, event);
    checkOutgoing(def.payload, payload, `The payload of the ${contract.name}.${event} event`);
    const frame: EventFrame = [contract.name, event, payload];
    hub.io?.to(room).emit(SERVER_EVENTS.event, frame);
  };
  return Object.freeze({
    emit: (room: string, contract: AnyContract, event: string, payload: unknown) => {
      send(room, contract, event, payload);
    },
    emitToUser: (userId: string, contract: AnyContract, event: string, payload: unknown) => {
      if (typeof userId !== "string" || userId === "") {
        throw new TypeError("ctx.rooms.emitToUser: userId must be a non-empty string");
      }
      send(userRoom(userId), contract, event, payload);
    },
  }) as RoomEvents;
}
