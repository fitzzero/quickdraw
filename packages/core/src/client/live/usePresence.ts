"use client";

// `usePresence(room)` (RFC 0003 section 12.5): the ids of the users in an
// app room the connection's socket is in, kept current by the server's
// `qd:presence` frames (`presence.ts`). A method joins the socket to the room
// (`ctx.rooms.join`); until then, and after it leaves or the socket
// disconnects, the list is empty.

import { useCallback, useSyncExternalStore } from "react";
import { useLiveData } from "./liveHooks";

/** The users in `room`, as the server last said: the same array until it changes. */
export function usePresence(room: string): readonly string[] {
  const { live } = useLiveData("usePresence");
  const listen = useCallback(
    (listener: () => void) => live.presence.listen(room, listener),
    [live, room],
  );
  const read = (): readonly string[] => live.presence.users(room);
  return useSyncExternalStore(listen, read, read);
}
