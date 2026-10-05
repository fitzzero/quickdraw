// The names an app room may have (RFC 0003 section 12.5): `ctx.rooms` and
// `qd.rooms` refuse the framework's own rooms (`qd:` entity, collection,
// topic and stream rooms, and `user:` rooms), which a socket enters only
// through their authorized paths, so a method cannot be talked into putting
// a socket in another user's room or taking it out of one.

import { RESERVED_ROOM_PREFIXES } from "../../contract/names";
import { MAX_SCOPE_LENGTH } from "../../protocol/version";
import { unreadable } from "../transports/ack";

/** Throws `VALIDATION` unless `room` can name an app room. */
export function checkRoom(room: unknown): asserts room is string {
  if (typeof room !== "string" || room === "" || room.length > MAX_SCOPE_LENGTH) {
    throw unreadable(`A room name is a string of 1 to ${MAX_SCOPE_LENGTH} characters`);
  }
  if (RESERVED_ROOM_PREFIXES.some((prefix) => room.startsWith(prefix))) {
    throw unreadable(
      `Room "${room}" is reserved: rooms starting with ${RESERVED_ROOM_PREFIXES.join(" or ")} are joined only through their own subscriptions`,
    );
  }
}
