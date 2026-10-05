"use client";

// `qd.<service>.<event>.useEvent(handler)` (RFC 0003 sections 8.3 and
// 12.5): calls `handler` with the payload of each of the contract's typed
// room events the server sends this socket (`ctx.rooms.emit`), while the
// component is mounted. The handler may change on every render without
// re-registering. Replaces 4.1's `useRoomEvents` with its hand-written event
// names (4.1 `src/client/useRoomEvents.ts:46`); the socket gets the
// events of the rooms a method joined it to, so pair it with that method.

import { useEffect, useRef } from "react";
import { useLiveData } from "./liveHooks";

/** Options of `useEvent`. */
export interface UseEventOptions {
  /** `false` calls nothing. Default `true`. */
  readonly enabled?: boolean;
}

/** Calls `handler` with each `event` of `service` the socket receives. */
export function useEvent<Payload>(
  service: string,
  event: string,
  handler: (payload: Payload) => void,
  options: UseEventOptions = {},
): void {
  const { live } = useLiveData(`${service}.${event}.useEvent`);
  const latest = useRef(handler);
  useEffect(() => {
    latest.current = handler;
  });
  const enabled = options.enabled !== false;
  useEffect(() => {
    if (!enabled) {
      return undefined;
    }
    return live.events.on(service, event, (payload) => {
      latest.current(payload as Payload);
    });
  }, [live, service, event, enabled]);
}
