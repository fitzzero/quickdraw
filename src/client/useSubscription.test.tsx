import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { renderHook, act } from "@testing-library/react";
import * as React from "react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { Socket } from "socket.io-client";
import type { QuickdrawSocketContextValue, SubscriptionRegistry } from "./types";
import { useSubscription } from "./useSubscription";

const QuickdrawSocketContext =
  React.createContext<QuickdrawSocketContextValue | null>(null);

vi.mock("./QuickdrawProvider", () => ({
  useQuickdrawSocket: () => React.useContext(QuickdrawSocketContext),
}));

function createMockSocket() {
  const listeners = new Map<string, Set<(...args: unknown[]) => void>>();

  return {
    id: "mock-socket-id",
    connected: true,
    emit: vi.fn(),
    on: vi.fn((event: string, handler: (...args: unknown[]) => void) => {
      if (!listeners.has(event)) listeners.set(event, new Set());
      listeners.get(event)!.add(handler);
    }),
    off: vi.fn((event: string, handler: (...args: unknown[]) => void) => {
      listeners.get(event)?.delete(handler);
    }),
    disconnect: vi.fn(),
    _listeners: listeners,
  };
}

function createMockRegistry(): SubscriptionRegistry & {
  _acquireCalls: string[];
} {
  const subscriptions = new Map<string, { refCount: number; cleanup?: () => void }>();
  const acquireCalls: string[] = [];

  return {
    _acquireCalls: acquireCalls,
    acquire: vi.fn((key: string) => {
      acquireCalls.push(key);
      const existing = subscriptions.get(key);
      if (existing) {
        existing.refCount++;
        return { isNew: false, entry: existing };
      }
      const entry = { refCount: 1 };
      subscriptions.set(key, entry);
      return { isNew: true, entry };
    }),
    release: vi.fn((key: string) => {
      const entry = subscriptions.get(key);
      if (!entry) return false;
      entry.refCount--;
      if (entry.refCount <= 0) {
        entry.cleanup?.();
        subscriptions.delete(key);
        return true;
      }
      return false;
    }),
    setCleanup: vi.fn((key: string, cleanup: () => void) => {
      const entry = subscriptions.get(key);
      if (entry) entry.cleanup = cleanup;
    }),
    clear: vi.fn(() => {
      subscriptions.clear();
    }),
  };
}

function createMockContext(
  socket: ReturnType<typeof createMockSocket>,
  overrides: Partial<QuickdrawSocketContextValue> = {}
): QuickdrawSocketContextValue {
  return {
    socket: socket as unknown as Socket,
    isConnected: true,
    userId: "test-user",
    serviceAccess: {},
    connect: vi.fn(),
    disconnect: vi.fn(),
    subscriptionRegistry: createMockRegistry(),
    subscriptionBatcher: { enqueue: vi.fn() },
    ...overrides,
  };
}

function createWrapper(context: QuickdrawSocketContextValue) {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false, gcTime: 0 } },
  });

  return function Wrapper({ children }: { children: React.ReactNode }) {
    return (
      <QueryClientProvider client={client}>
        <QuickdrawSocketContext.Provider value={context}>
          {children}
        </QuickdrawSocketContext.Provider>
      </QueryClientProvider>
    );
  };
}

function setVisibilityState(state: DocumentVisibilityState) {
  Object.defineProperty(document, "visibilityState", {
    value: state,
    writable: true,
    configurable: true,
  });
}

function fireVisibilityChange() {
  document.dispatchEvent(new Event("visibilitychange"));
}

describe("useSubscription - refetchOnWindowFocus", () => {
  let mockSocket: ReturnType<typeof createMockSocket>;
  let addEventSpy: ReturnType<typeof vi.spyOn>;
  let removeEventSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    mockSocket = createMockSocket();
    addEventSpy = vi.spyOn(document, "addEventListener");
    removeEventSpy = vi.spyOn(document, "removeEventListener");
    setVisibilityState("visible");
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.clearAllMocks();
    addEventSpy.mockRestore();
    removeEventSpy.mockRestore();
  });

  it("does not add a visibility listener by default", () => {
    const context = createMockContext(mockSocket);
    const wrapper = createWrapper(context);

    renderHook(
      () => useSubscription("chatService", "chat-1"),
      { wrapper }
    );

    const visibilityCalls = addEventSpy.mock.calls.filter(
      ([event]) => event === "visibilitychange"
    );
    expect(visibilityCalls).toHaveLength(0);
  });

  it("adds a visibility listener when refetchOnWindowFocus is true", () => {
    const context = createMockContext(mockSocket);
    const wrapper = createWrapper(context);

    renderHook(
      () =>
        useSubscription("chatService", "chat-1", {
          refetchOnWindowFocus: true,
        }),
      { wrapper }
    );

    const visibilityCalls = addEventSpy.mock.calls.filter(
      ([event]) => event === "visibilitychange"
    );
    expect(visibilityCalls).toHaveLength(1);
  });

  it("re-subscribes through the batcher when tab becomes visible", () => {
    const context = createMockContext(mockSocket);
    const wrapper = createWrapper(context);

    renderHook(
      () =>
        useSubscription("chatService", "chat-1", {
          refetchOnWindowFocus: true,
        }),
      { wrapper }
    );

    const batcherEnqueue = context.subscriptionBatcher.enqueue as ReturnType<typeof vi.fn>;
    const initialCallCount = batcherEnqueue.mock.calls.length;

    setVisibilityState("visible");
    fireVisibilityChange();

    // Debounce hasn't fired yet
    expect(batcherEnqueue.mock.calls.length).toBe(initialCallCount);

    act(() => {
      vi.advanceTimersByTime(200);
    });

    expect(batcherEnqueue.mock.calls.length).toBe(initialCallCount + 1);
    expect(batcherEnqueue).toHaveBeenLastCalledWith(
      "chatService",
      "chat-1",
      "Read",
      expect.any(Function)
    );
  });

  it("ignores visibility changes when tab is hidden", () => {
    const context = createMockContext(mockSocket);
    const wrapper = createWrapper(context);

    renderHook(
      () =>
        useSubscription("chatService", "chat-1", {
          refetchOnWindowFocus: true,
        }),
      { wrapper }
    );

    const batcherEnqueue = context.subscriptionBatcher.enqueue as ReturnType<typeof vi.fn>;
    const initialCallCount = batcherEnqueue.mock.calls.length;

    setVisibilityState("hidden");
    fireVisibilityChange();

    act(() => {
      vi.advanceTimersByTime(300);
    });

    expect(batcherEnqueue.mock.calls.length).toBe(initialCallCount);
  });

  it("debounces rapid visibility toggles into a single batcher call", () => {
    const context = createMockContext(mockSocket);
    const wrapper = createWrapper(context);

    renderHook(
      () =>
        useSubscription("chatService", "chat-1", {
          refetchOnWindowFocus: true,
        }),
      { wrapper }
    );

    const batcherEnqueue = context.subscriptionBatcher.enqueue as ReturnType<typeof vi.fn>;
    const initialCallCount = batcherEnqueue.mock.calls.length;

    // Rapid toggles: visible -> hidden -> visible -> hidden -> visible
    setVisibilityState("visible");
    fireVisibilityChange();
    act(() => { vi.advanceTimersByTime(50); });

    setVisibilityState("hidden");
    fireVisibilityChange();
    act(() => { vi.advanceTimersByTime(50); });

    setVisibilityState("visible");
    fireVisibilityChange();
    act(() => { vi.advanceTimersByTime(50); });

    setVisibilityState("hidden");
    fireVisibilityChange();
    act(() => { vi.advanceTimersByTime(50); });

    setVisibilityState("visible");
    fireVisibilityChange();

    // Flush the final debounce
    act(() => {
      vi.advanceTimersByTime(200);
    });

    // Only one additional batcher call despite 3 "visible" events
    expect(batcherEnqueue.mock.calls.length).toBe(initialCallCount + 1);
  });

  it("only the subscription owner registers the visibility listener (deduplication)", () => {
    const registry = createMockRegistry();
    const context = createMockContext(mockSocket, {
      subscriptionRegistry: registry,
    });

    const wrapper = createWrapper(context);
    const hookOptions = { refetchOnWindowFocus: true as const };

    // First component subscribing to the same entity - gets isNew: true
    renderHook(
      () => useSubscription("chatService", "chat-1", hookOptions),
      { wrapper }
    );

    // Second component subscribing to same entity - gets isNew: false
    renderHook(
      () => useSubscription("chatService", "chat-1", hookOptions),
      { wrapper }
    );

    const visibilityCalls = addEventSpy.mock.calls.filter(
      ([event]) => event === "visibilitychange"
    );

    // Only one listener registered (by the owner), not two
    expect(visibilityCalls).toHaveLength(1);

    // Verify both acquired the same key
    expect(registry._acquireCalls).toEqual([
      "chatService:chat-1",
      "chatService:chat-1",
    ]);
  });

  it("deduplication: one batcher call per entity on visibility change, not per component", () => {
    const registry = createMockRegistry();
    const batcherEnqueue = vi.fn();
    const context = createMockContext(mockSocket, {
      subscriptionRegistry: registry,
      subscriptionBatcher: { enqueue: batcherEnqueue },
    });

    const wrapper = createWrapper(context);
    const hookOptions = { refetchOnWindowFocus: true as const };

    renderHook(
      () => useSubscription("chatService", "chat-1", hookOptions),
      { wrapper }
    );

    renderHook(
      () => useSubscription("chatService", "chat-1", hookOptions),
      { wrapper }
    );

    const initialCallCount = batcherEnqueue.mock.calls.length;

    setVisibilityState("visible");
    fireVisibilityChange();

    act(() => {
      vi.advanceTimersByTime(200);
    });

    // Exactly one re-subscribe call, not two
    expect(batcherEnqueue.mock.calls.length).toBe(initialCallCount + 1);
  });

  it("removes the visibility listener on unmount", () => {
    const context = createMockContext(mockSocket);
    const wrapper = createWrapper(context);

    const { unmount } = renderHook(
      () =>
        useSubscription("chatService", "chat-1", {
          refetchOnWindowFocus: true,
        }),
      { wrapper }
    );

    const visibilityAdds = addEventSpy.mock.calls.filter(
      ([event]) => event === "visibilitychange"
    );
    expect(visibilityAdds).toHaveLength(1);

    unmount();

    const visibilityRemoves = removeEventSpy.mock.calls.filter(
      ([event]) => event === "visibilitychange"
    );
    expect(visibilityRemoves).toHaveLength(1);
  });

  it("does not add visibility listener when entryId is null", () => {
    const context = createMockContext(mockSocket);
    const wrapper = createWrapper(context);

    renderHook(
      () =>
        useSubscription("chatService", null, {
          refetchOnWindowFocus: true,
        }),
      { wrapper }
    );

    const visibilityCalls = addEventSpy.mock.calls.filter(
      ([event]) => event === "visibilitychange"
    );
    expect(visibilityCalls).toHaveLength(0);
  });

  it("does not add visibility listener when disabled", () => {
    const context = createMockContext(mockSocket);
    const wrapper = createWrapper(context);

    renderHook(
      () =>
        useSubscription("chatService", "chat-1", {
          refetchOnWindowFocus: true,
          enabled: false,
        }),
      { wrapper }
    );

    const visibilityCalls = addEventSpy.mock.calls.filter(
      ([event]) => event === "visibilitychange"
    );
    expect(visibilityCalls).toHaveLength(0);
  });
});
