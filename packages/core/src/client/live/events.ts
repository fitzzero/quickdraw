// Typed room events on the client (RFC 0003 sections 8.3 and 12.5): one
// `qd:event` listener per connection routes each frame, `[service, event,
// payload]`, to the handlers registered for that service and event
// (`useEvent`). This replaces 4.1's `useRoomEvents`, which put a socket
// listener per event name on the socket (`legacy-src/client/useRoomEvents.ts:46`).
// An event nobody handles when it arrives is dropped; a handler that throws
// neither stops the others nor the socket. A frame with elements after
// `payload` is read as its first three: a later revision of the protocol
// may append elements, never insert them (`protocol/envelope.ts`).
//
// React-free: the live data (`liveData.ts`) makes one per connection and
// `QueryClient`.

import { isName } from "../../protocol/guards";
import { notifyEach } from "../watch";

/** A handler of one event: called with each payload. */
export type EventHandler = (payload: unknown) => void;

/** The event handlers of one connection. */
export interface EventBus {
  /** Calls `handler` with the payload of each `event` of `service` until the returned function runs. */
  on(service: string, event: string, handler: EventHandler): () => void;
  /** A `qd:event` frame arrived. */
  receive(frame: unknown): void;
}

function eventKey(service: string, event: string): string {
  return `${service}\u0000${event}`;
}

/** Creates the event handlers of one connection. */
export function createEventBus(): EventBus {
  const handlers = new Map<string, Set<EventHandler>>();
  return Object.freeze({
    on(service: string, event: string, handler: EventHandler): () => void {
      const key = eventKey(service, event);
      const set = handlers.get(key) ?? new Set<EventHandler>();
      handlers.set(key, set);
      // One entry per registration, so the same function may be registered twice.
      const entry: EventHandler = (payload) => {
        handler(payload);
      };
      set.add(entry);
      return () => {
        set.delete(entry);
        if (set.size === 0 && handlers.get(key) === set) {
          handlers.delete(key);
        }
      };
    },
    receive(frame: unknown): void {
      if (!Array.isArray(frame) || frame.length < 3) {
        return;
      }
      const [service, event, payload] = frame as readonly unknown[];
      const set =
        isName(service) && isName(event) ? handlers.get(eventKey(service, event)) : undefined;
      if (set !== undefined) {
        notifyEach(set, (handler) => {
          handler(payload);
        });
      }
    },
  });
}
