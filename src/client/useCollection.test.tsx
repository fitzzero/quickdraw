import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { renderHook, waitFor, act } from "@testing-library/react";
import * as React from "react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { Socket } from "socket.io-client";
import type {
  CollectionDelta,
  CollectionSnapshotResponse,
  ServiceResponse,
} from "../shared/types";
import { collectionRoom } from "../shared/types";
import type { QuickdrawSocketContextValue, SubscriptionRegistry } from "./types";
import { useCollection } from "./useCollection";

const QuickdrawSocketContext = React.createContext<QuickdrawSocketContextValue | null>(null);

vi.mock("./QuickdrawProvider", () => ({
  useQuickdrawSocket: () => React.useContext(QuickdrawSocketContext),
}));

interface Row {
  id: string;
  v: number;
}

const row = (id: string, v = 0): Row => ({ id, v });

function snapshot(
  items: Row[],
  opts: Partial<CollectionSnapshotResponse<Row>> = {},
): CollectionSnapshotResponse<Row> {
  return {
    items,
    nextCursor: opts.nextCursor ?? null,
    totalCount: opts.totalCount ?? items.length,
    ids: opts.ids,
    rev: opts.rev ?? 100,
  };
}

type Ack = (response: ServiceResponse<CollectionSnapshotResponse<Row>>) => void;

interface SubscribeCall {
  payload: { collection: string; scopeId: string; cursor?: string; limit?: number };
  ack: Ack;
}

function createMockSocket() {
  const listeners = new Map<string, Set<(...args: unknown[]) => void>>();
  const subscribeCalls: SubscribeCall[] = [];
  const unsubscribeCalls: unknown[] = [];
  let autoRespond: ((call: SubscribeCall) => void) | null = null;

  const socket = {
    id: "mock-socket-id",
    connected: true,
    on: vi.fn((event: string, handler: (...args: unknown[]) => void) => {
      if (!listeners.has(event)) listeners.set(event, new Set());
      listeners.get(event)!.add(handler);
    }),
    off: vi.fn((event: string, handler: (...args: unknown[]) => void) => {
      listeners.get(event)?.delete(handler);
    }),
    emit: vi.fn((event: string, payload: unknown, ack?: unknown) => {
      if (event.endsWith(":collection:subscribe")) {
        const call = { payload, ack } as unknown as SubscribeCall;
        subscribeCalls.push(call);
        autoRespond?.(call);
      } else if (event.endsWith(":collection:unsubscribe")) {
        unsubscribeCalls.push(payload);
      }
    }),
    disconnect: vi.fn(),
    _fire(event: string, ...args: unknown[]) {
      for (const handler of listeners.get(event) ?? []) handler(...args);
    },
    _listeners: listeners,
    subscribeCalls,
    unsubscribeCalls,
    setAutoRespond(fn: ((call: SubscribeCall) => void) | null) {
      autoRespond = fn;
    },
  };
  return socket;
}

function createMockRegistry(): SubscriptionRegistry {
  const subscriptions = new Map<
    string,
    { refCount: number; cleanup?: () => void; controller?: unknown }
  >();
  return {
    acquire(key: string) {
      const existing = subscriptions.get(key);
      if (existing) {
        existing.refCount++;
        return { isNew: false, entry: existing };
      }
      const entry = { refCount: 1 };
      subscriptions.set(key, entry);
      return { isNew: true, entry };
    },
    release(key: string) {
      const entry = subscriptions.get(key);
      if (!entry) return false;
      entry.refCount--;
      if (entry.refCount <= 0) {
        entry.cleanup?.();
        subscriptions.delete(key);
        return true;
      }
      return false;
    },
    setCleanup(key: string, cleanup: () => void) {
      const entry = subscriptions.get(key);
      if (entry) entry.cleanup = cleanup;
    },
    clear() {
      for (const entry of subscriptions.values()) entry.cleanup?.();
      subscriptions.clear();
    },
  };
}

function createContext(
  socket: ReturnType<typeof createMockSocket>,
  registry: SubscriptionRegistry,
  overrides: Partial<QuickdrawSocketContextValue> = {},
): QuickdrawSocketContextValue {
  return {
    socket: socket as unknown as Socket,
    isConnected: true,
    userId: "test-user",
    serviceAccess: {},
    connect: vi.fn(),
    disconnect: vi.fn(),
    subscriptionRegistry: registry,
    subscriptionBatcher: { enqueue: vi.fn() },
    isRateLimited: false,
    reportRateLimited: vi.fn(),
    ...overrides,
  };
}

const EVENT = collectionRoom("chatService", "byChat", "chat-1");

describe("useCollection", () => {
  let socket: ReturnType<typeof createMockSocket>;
  let registry: SubscriptionRegistry;
  let currentContext: QuickdrawSocketContextValue;
  let queryClient: QueryClient;

  function wrapper({ children }: { children: React.ReactNode }) {
    return (
      <QueryClientProvider client={queryClient}>
        <QuickdrawSocketContext.Provider value={currentContext}>
          {children}
        </QuickdrawSocketContext.Provider>
      </QueryClientProvider>
    );
  }

  beforeEach(() => {
    socket = createMockSocket();
    registry = createMockRegistry();
    currentContext = createContext(socket, registry);
    queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    });
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  it("subscribes cursor-less, applies the snapshot, and streams deltas", async () => {
    socket.setAutoRespond((call) =>
      call.ack({
        success: true,
        data: snapshot([row("a", 1), row("b", 1)], { nextCursor: "2", totalCount: 3, rev: 100 }),
      }),
    );

    const { result } = renderHook(() => useCollection<Row>("chatService", "byChat", "chat-1"), {
      wrapper,
    });

    expect(result.current.isLoading).toBe(true);

    await waitFor(() => {
      expect(result.current.items.map((i) => i.id)).toEqual(["a", "b"]);
    });
    expect(result.current.totalCount).toBe(3);
    expect(result.current.hasMore).toBe(true);
    expect(result.current.isLoading).toBe(false);
    expect(socket.subscribeCalls[0]!.payload).toMatchObject({
      collection: "byChat",
      scopeId: "chat-1",
    });
    expect(socket.subscribeCalls[0]!.payload.cursor).toBeUndefined();

    act(() => {
      socket._fire(EVENT, { type: "added", item: row("c", 1), rev: 200 } as CollectionDelta<Row>);
    });
    await waitFor(() => {
      expect(result.current.items.map((i) => i.id)).toEqual(["a", "b", "c"]);
    });
    expect(result.current.totalCount).toBe(4);

    act(() => {
      socket._fire(EVENT, { type: "removed", id: "a", rev: 300 } as CollectionDelta<Row>);
    });
    await waitFor(() => {
      expect(result.current.items.map((i) => i.id)).toEqual(["b", "c"]);
    });

    // Stale delta (older rev) is ignored
    act(() => {
      socket._fire(EVENT, { type: "added", item: row("a", 9), rev: 250 } as CollectionDelta<Row>);
    });
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(result.current.items.map((i) => i.id)).toEqual(["b", "c"]);
  });

  it("buffers deltas that arrive during the in-flight snapshot and applies them on top", async () => {
    const { result } = renderHook(() => useCollection<Row>("chatService", "byChat", "chat-1"), {
      wrapper,
    });

    await waitFor(() => {
      expect(socket.subscribeCalls).toHaveLength(1);
    });

    // Deltas race the pending snapshot ack
    act(() => {
      socket._fire(EVENT, { type: "added", item: row("c", 2), rev: 300 } as CollectionDelta<Row>);
      socket._fire(EVENT, {
        type: "updated",
        item: row("a", 7),
        rev: 50, // older than the snapshot — must lose
      } as CollectionDelta<Row>);
    });

    act(() => {
      socket.subscribeCalls[0]!.ack({
        success: true,
        data: snapshot([row("a", 1), row("b", 1)], { rev: 100 }),
      });
    });

    await waitFor(() => {
      expect(result.current.items.map((i) => i.id)).toEqual(["a", "b", "c"]);
    });
    // The newer buffered add applied; the stale buffered update lost
    expect(result.current.byId.get("a")).toEqual(row("a", 1));
    expect(result.current.byId.get("c")).toEqual(row("c", 2));
  });

  it("loadMore pages with the cursor and merges without pruning", async () => {
    socket.setAutoRespond((call) => {
      if (call.payload.cursor === undefined) {
        call.ack({
          success: true,
          data: snapshot([row("a")], { nextCursor: "1", totalCount: 3, rev: 100 }),
        });
      } else {
        call.ack({
          success: true,
          data: snapshot([row("b"), row("c")], { nextCursor: null, totalCount: 3, rev: 100 }),
        });
      }
    });

    const { result } = renderHook(() => useCollection<Row>("chatService", "byChat", "chat-1"), {
      wrapper,
    });

    await waitFor(() => {
      expect(result.current.items).toHaveLength(1);
    });
    expect(result.current.hasMore).toBe(true);

    await act(async () => {
      await result.current.loadMore();
    });

    expect(result.current.items.map((i) => i.id)).toEqual(["a", "b", "c"]);
    expect(result.current.hasMore).toBe(false);
    expect(socket.subscribeCalls[1]!.payload.cursor).toBe("1");
  });

  it("re-snapshots on reconnect and prunes rows deleted while offline", async () => {
    let snapshotItems = [row("a"), row("b")];
    let snapshotIds = ["a", "b"];
    let rev = 100;
    socket.setAutoRespond((call) =>
      call.ack({
        success: true,
        data: snapshot(snapshotItems, { ids: snapshotIds, rev }),
      }),
    );

    const { result, rerender } = renderHook(
      () => useCollection<Row>("chatService", "byChat", "chat-1"),
      { wrapper },
    );

    await waitFor(() => {
      expect(result.current.items.map((i) => i.id)).toEqual(["a", "b"]);
    });

    // Disconnect: provider clears the registry and flips isConnected
    act(() => {
      registry.clear();
      currentContext = { ...currentContext, isConnected: false };
    });
    rerender();

    // While offline the server deleted "b" and added "c"
    snapshotItems = [row("a"), row("c")];
    snapshotIds = ["a", "c"];
    rev = 200;

    act(() => {
      currentContext = { ...currentContext, isConnected: true };
    });
    rerender();

    await waitFor(() => {
      expect(result.current.items.map((i) => i.id)).toEqual(["a", "c"]);
    });
    // Two cursor-less subscribes total: initial + reconnect
    expect(socket.subscribeCalls).toHaveLength(2);
  });

  it("a reset delta triggers a debounced re-snapshot", async () => {
    socket.setAutoRespond((call) =>
      call.ack({ success: true, data: snapshot([row("a")], { rev: 100 }) }),
    );

    const { result } = renderHook(() => useCollection<Row>("chatService", "byChat", "chat-1"), {
      wrapper,
    });

    await waitFor(() => {
      expect(result.current.items).toHaveLength(1);
    });

    act(() => {
      socket._fire(EVENT, { type: "reset", rev: 999 } as CollectionDelta<Row>);
      socket._fire(EVENT, { type: "reset", rev: 999 } as CollectionDelta<Row>);
    });

    // Both resets collapse into one re-snapshot after the 100ms debounce
    await waitFor(() => {
      expect(socket.subscribeCalls).toHaveLength(2);
    });
    await new Promise((resolve) => setTimeout(resolve, 150));
    expect(socket.subscribeCalls).toHaveLength(2);
  });

  it("dedupes the subscription across components and shares the pipeline", async () => {
    socket.setAutoRespond((call) => {
      if (call.payload.cursor === undefined) {
        call.ack({
          success: true,
          data: snapshot([row("a")], { nextCursor: "1", totalCount: 2, rev: 100 }),
        });
      } else {
        call.ack({
          success: true,
          data: snapshot([row("b")], { nextCursor: null, totalCount: 2, rev: 100 }),
        });
      }
    });

    const first = renderHook(() => useCollection<Row>("chatService", "byChat", "chat-1"), {
      wrapper,
    });
    const second = renderHook(() => useCollection<Row>("chatService", "byChat", "chat-1"), {
      wrapper,
    });

    await waitFor(() => {
      expect(first.result.current.items).toHaveLength(1);
      expect(second.result.current.items).toHaveLength(1);
    });
    // One shared cursor-less subscribe, not two
    expect(socket.subscribeCalls).toHaveLength(1);

    // The non-owner can drive the shared pipeline (loadMore via controller)
    await act(async () => {
      await second.result.current.loadMore();
    });
    await waitFor(() => {
      expect(first.result.current.items.map((i) => i.id)).toEqual(["a", "b"]);
    });

    // Releasing the owner keeps the subscription alive for the joiner
    first.unmount();
    expect(socket.unsubscribeCalls).toHaveLength(0);
    second.unmount();
    expect(socket.unsubscribeCalls).toHaveLength(1);
  });

  it("surfaces snapshot errors and calls onError", async () => {
    socket.setAutoRespond((call) => call.ack({ success: false, error: "Access denied" }));
    const onError = vi.fn();

    const { result } = renderHook(
      () => useCollection<Row>("chatService", "byChat", "chat-1", { onError }),
      { wrapper },
    );

    await waitFor(() => {
      expect(result.current.isError).toBe(true);
    });
    expect(result.current.error).toBe("Access denied");
    expect(result.current.isLoading).toBe(false);
    expect(onError).toHaveBeenCalledWith("Access denied");
  });

  it("does not subscribe when disabled or scopeId is null", async () => {
    renderHook(() => useCollection<Row>("chatService", "byChat", null), { wrapper });
    renderHook(() => useCollection<Row>("chatService", "byChat", "chat-1", { enabled: false }), {
      wrapper,
    });

    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(socket.subscribeCalls).toHaveLength(0);
  });

  it("applies compare ordering and insertPosition", async () => {
    socket.setAutoRespond((call) =>
      call.ack({ success: true, data: snapshot([row("b", 2), row("a", 1)], { rev: 100 }) }),
    );

    const compare = (x: Row, y: Row) => x.id.localeCompare(y.id);
    const sorted = renderHook(
      () => useCollection<Row>("chatService", "byChat", "chat-1", { compare }),
      { wrapper },
    );

    await waitFor(() => {
      expect(sorted.result.current.items.map((i) => i.id)).toEqual(["a", "b"]);
    });
    sorted.unmount();

    // Without compare, insertPosition: "start" puts new adds first
    const unsorted = renderHook(
      () => useCollection<Row>("chatService", "byChat", "chat-1", { insertPosition: "start" }),
      { wrapper },
    );
    await waitFor(() => {
      expect(unsorted.result.current.items.length).toBeGreaterThan(0);
    });

    act(() => {
      socket._fire(EVENT, { type: "added", item: row("z", 9), rev: 500 } as CollectionDelta<Row>);
    });
    await waitFor(() => {
      expect(unsorted.result.current.items[0]!.id).toBe("z");
    });
  });

  it("forwards deltas to onDelta", async () => {
    socket.setAutoRespond((call) =>
      call.ack({ success: true, data: snapshot([row("a")], { rev: 100 }) }),
    );
    const onDelta = vi.fn();

    renderHook(() => useCollection<Row>("chatService", "byChat", "chat-1", { onDelta }), {
      wrapper,
    });

    await waitFor(() => {
      expect(socket.subscribeCalls).toHaveLength(1);
    });

    const delta: CollectionDelta<Row> = { type: "added", item: row("x"), rev: 400 };
    act(() => {
      socket._fire(EVENT, delta);
    });

    await waitFor(() => {
      expect(onDelta).toHaveBeenCalledWith(delta);
    });
  });
});
