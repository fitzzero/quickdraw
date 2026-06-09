"use client";

import * as React from "react";
import { useQuickdrawSocket } from "./QuickdrawProvider";
import type { UseRoomEventsOptions } from "./types";

/**
 * Hook for listening to custom socket events with managed lifecycle.
 *
 * Handles `socket.on`/`socket.off` cleanup, reconnection re-attachment,
 * and connection-awareness. Each component gets its own listeners (no dedup needed).
 * Room scoping is handled server-side via `emitToRoom`.
 *
 * Pair with `useSubscription` to ensure the socket is in the correct room:
 * `useSubscription` manages room membership, `useRoomEvents` manages event listeners.
 *
 * @param handlers - Map of event names to handler functions. Event names should be
 *   stable (don't change between renders). Handler functions can change freely.
 * @param options - Optional configuration
 *
 * @example
 * ```tsx
 * function ChatView({ chatId }: { chatId: string }) {
 *   const [messages, setMessages] = useState<Message[]>([]);
 *   const [typing, setTyping] = useState(false);
 *
 *   // Subscribe to the chat room (manages room membership)
 *   const { data: chat } = useSubscription('chatService', chatId);
 *
 *   // Listen for custom events broadcast to the chat room
 *   useRoomEvents({
 *     'chat:message': (msg: Message) => setMessages(prev => [...prev, msg]),
 *     'agent_typing_start': () => setTyping(true),
 *     'agent_typing_stop': () => setTyping(false),
 *   });
 *
 *   return <div>{chat?.title}</div>;
 * }
 * ```
 */
export function useRoomEvents(
  handlers: Record<string, (data: never) => void>,
  options?: UseRoomEventsOptions,
): void {
  const { socket, isConnected } = useQuickdrawSocket();
  const { enabled = true } = options ?? {};

  // Store handlers in a ref so handler identity changes don't trigger effect reruns.
  // The event names (keys) are tracked separately for structural changes.
  const handlersRef = React.useRef(handlers);
  React.useEffect(() => {
    handlersRef.current = handlers;
  }, [handlers]);

  // Memoize the sorted event names so the effect only re-runs when the
  // set of listened events actually changes, not on every render.
  const eventNames = Object.keys(handlers);
  const eventNamesKey = eventNames.join("\0");
  const stableEventNames = React.useMemo(
    () => eventNames,
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [eventNamesKey],
  );

  React.useEffect(() => {
    if (!socket || !isConnected || !enabled || stableEventNames.length === 0) {
      return;
    }

    // Create stable wrapper functions that delegate to the ref'd handlers.
    // This lets consumers change handler implementations without re-subscribing.
    const wrappers = new Map<string, (...args: unknown[]) => void>();

    for (const eventName of stableEventNames) {
      const wrapper = (...args: unknown[]) => {
        handlersRef.current[eventName]?.(...(args as [never]));
      };
      wrappers.set(eventName, wrapper);
      socket.on(eventName, wrapper);
    }

    return () => {
      for (const [eventName, wrapper] of wrappers) {
        socket.off(eventName, wrapper);
      }
    };
  }, [socket, isConnected, enabled, stableEventNames]);
}
