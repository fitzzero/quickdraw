// The app room a host-served member names (host mode, RFC 0003 section
// 12.5), read from the contract as the server reads it: a channel's
// `requires: { room }` (a name, a function of the payload, or `{ prefix }`)
// and a stream's `access: { room: (scope) => room }`. A computed name that
// is not a string, is empty, is the framework's (`qd:`, `user:`) or has the
// shape of a socket id names no room. The peer side asks which host to send
// to; the host side checks that a message or a subscribe is for its room.
//
// React-free.

import { reservedRoomPrefix, socketIdShaped } from "../../contract/names";
import type { ChannelDef, StreamDef } from "../../contract/realtime";

/** `value`, when it can name an app room. */
function appRoom(value: unknown): string | undefined {
  return typeof value === "string" &&
    value !== "" &&
    reservedRoomPrefix(value) === undefined &&
    !socketIdShaped(value)
    ? value
    : undefined;
}

/** Calls a room function of the contract; one that throws names no room. */
function computed(room: unknown, value: unknown): string | undefined {
  try {
    return appRoom((room as (input: unknown) => unknown)(value));
  } catch {
    return undefined;
  }
}

/**
 * The room a host-served channel's message is for: its requirement's name,
 * the one it computes from `payload`, or for `{ prefix }` the first of
 * `rooms` (the rooms whose host is known) that starts with it.
 */
export function channelRoomOf(
  def: ChannelDef,
  payload: unknown,
  rooms: Iterable<string>,
): string | undefined {
  const room = def.requires?.room;
  if (typeof room === "string") {
    return room;
  }
  if (typeof room === "function") {
    return computed(room, payload);
  }
  if (typeof room === "object") {
    for (const known of rooms) {
      if (known.startsWith(room.prefix)) {
        return known;
      }
    }
  }
  return undefined;
}

/** The room whose host serves a host-served stream's feed of `scope`. */
export function streamRoomOf(def: StreamDef, scope: string): string | undefined {
  const access = typeof def.access === "object" ? def.access : undefined;
  const room = access?.room;
  return typeof room === "function" ? computed(room, scope) : undefined;
}
