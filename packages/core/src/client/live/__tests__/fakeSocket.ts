// A connection whose socket the test drives, for races a real server cannot
// order on demand (a delta that arrives while a snapshot is in flight, a
// page answered after a reload began). It records every frame the client
// emits; the test answers acknowledgements and fires server frames itself.
// 4.1's `useCollection` tests drove a mock socket the same way
// (`legacy-src/client/useCollection.test.tsx:44-81`).

import { QueryClient } from "@tanstack/react-query";
import type { QuickdrawConnection } from "../../connection";
import { createSubscriptionLane, type LaneCallback } from "../../lane";

/** One frame the client emitted, and its acknowledgement when it asked for one. */
export interface Emitted {
  readonly event: string;
  readonly frame: Readonly<Record<string, unknown>>;
  readonly ack: LaneCallback | undefined;
  /** True once its acknowledgement was answered (or failed with the socket). */
  answered: boolean;
}

type Listener = (...args: unknown[]) => void;

/** A fake connection, its emitted frames, and the controls of its socket. */
export function fakeConnection() {
  const listeners = new Map<string, Set<Listener>>();
  const emitted: Emitted[] = [];
  const fire = (event: string, ...args: unknown[]): void => {
    for (const listener of [...(listeners.get(event) ?? [])]) {
      listener(...args);
    }
  };
  const socket = {
    connected: true,
    on(event: string, listener: Listener) {
      const set = listeners.get(event) ?? new Set<Listener>();
      set.add(listener);
      listeners.set(event, set);
      return socket;
    },
    emit(event: string, frame: Readonly<Record<string, unknown>>) {
      emitted.push({ event, frame, ack: undefined, answered: true });
      return socket;
    },
    timeout() {
      return {
        emit(event: string, frame: Readonly<Record<string, unknown>>, ack: LaneCallback) {
          emitted.push({ event, frame, ack, answered: false });
        },
      };
    },
    listeners: (event: string): Listener[] => [...(listeners.get(event) ?? [])],
  };
  const host = { socket, timeoutMs: () => 10_000, hello: () => null, backoffRemaining: () => 0 };
  const subscriptionLane = createSubscriptionLane(
    host as unknown as Parameters<typeof createSubscriptionLane>[0],
  );
  const connection = {
    socket,
    subscriptionLane,
    getState: () => ({ status: "connected", hello: null, backoff: {} }),
    subscribe: () => () => undefined,
    reportRateLimited: () => undefined,
    backoffRemaining: () => 0,
  } as unknown as QuickdrawConnection;

  return {
    connection,
    emitted,
    /** The frames of `event` the client emitted, in order. */
    sent(event: string): Emitted[] {
      return emitted.filter((entry) => entry.event === event);
    },
    /** Answers the acknowledgement of the `index`th frame of `event`. */
    answer(event: string, index: number, reply: unknown): void {
      const entry = emitted.filter((candidate) => candidate.event === event)[index];
      if (entry?.ack === undefined || entry.answered) {
        throw new Error(`no ${event} #${index} waits for an answer`);
      }
      entry.answered = true;
      entry.ack(null, reply);
    },
    /** Delivers a server frame to the client. */
    deliver: (event: string, frame: unknown): void => {
      fire(event, frame);
    },
    /** Drops the socket: unanswered frames fail as Socket.IO fails them. */
    disconnect(): void {
      socket.connected = false;
      for (const entry of emitted.filter((candidate) => !candidate.answered)) {
        entry.answered = true;
        entry.ack?.(new Error("socket has been disconnected"), undefined);
      }
      fire("disconnect");
    },
    /** Connects the socket again. */
    reconnect(): void {
      socket.connected = true;
      fire("connect");
    },
    listenerCount: (event: string): number => socket.listeners(event).length,
  };
}

/** A query client for a test. */
export function testQueryClient(): QueryClient {
  return new QueryClient({ defaultOptions: { queries: { retry: false } } });
}
