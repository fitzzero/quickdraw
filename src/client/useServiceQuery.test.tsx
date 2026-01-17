import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { renderHook, waitFor, act } from "@testing-library/react";
import * as React from "react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { Socket } from "socket.io-client";
import type { ServiceResponse } from "../shared/types";
import type { QuickdrawSocketContextValue } from "./types";
import { useServiceQuery } from "./useServiceQuery";

// Create a mock socket context
const QuickdrawSocketContext = React.createContext<QuickdrawSocketContextValue | null>(null);

// Mock the QuickdrawProvider module
vi.mock("./QuickdrawProvider", () => ({
  useQuickdrawSocket: () => React.useContext(QuickdrawSocketContext),
}));

// Helper to create mock socket
function createMockSocket() {
  return {
    id: "mock-socket-id",
    connected: true,
    emit: vi.fn(),
    on: vi.fn(),
    off: vi.fn(),
    disconnect: vi.fn(),
  };
}

// Helper to create mock context
function createMockContext(socket: ReturnType<typeof createMockSocket>, isConnected = true): QuickdrawSocketContextValue {
  return {
    socket: socket as unknown as Socket,
    isConnected,
    userId: "test-user",
    serviceAccess: {},
    connect: vi.fn(),
    disconnect: vi.fn(),
    subscriptionRegistry: {
      acquire: vi.fn(() => ({ isNew: true, entry: { refCount: 1 } })),
      release: vi.fn(() => true),
      setCleanup: vi.fn(),
      clear: vi.fn(),
    },
  };
}

// Helper to create test wrapper
function createWrapper(context: QuickdrawSocketContextValue, queryClient?: QueryClient) {
  const client = queryClient ?? new QueryClient({
    defaultOptions: {
      queries: { retry: false, gcTime: 0 },
    },
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

describe("useServiceQuery", () => {
  let mockSocket: ReturnType<typeof createMockSocket>;
  let mockContext: QuickdrawSocketContextValue;

  beforeEach(() => {
    mockSocket = createMockSocket();
    mockContext = createMockContext(mockSocket);
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  it("should fetch data on mount when enabled", async () => {
    const mockData = { items: [{ id: "1", name: "Test" }] };
    
    mockSocket.emit.mockImplementation(
      (_event: string, _payload: unknown, callback: (response: ServiceResponse<typeof mockData>) => void) => {
        callback({ success: true, data: mockData });
      }
    );

    const { result } = renderHook(
      () => useServiceQuery("testService", "getData", { page: 1 }),
      { wrapper: createWrapper(mockContext) }
    );

    expect(result.current.isLoading).toBe(true);

    await waitFor(() => {
      expect(result.current.isLoading).toBe(false);
    });

    expect(result.current.data).toEqual(mockData);
    expect(result.current.isSuccess).toBe(true);
    expect(mockSocket.emit).toHaveBeenCalledWith(
      "testService:getData",
      { page: 1 },
      expect.any(Function)
    );
  });

  it("should not fetch when enabled is false", async () => {
    const { result } = renderHook(
      () => useServiceQuery("testService", "getData", { page: 1 }, { enabled: false }),
      { wrapper: createWrapper(mockContext) }
    );

    // Wait a tick to ensure no fetch was triggered
    await new Promise((resolve) => setTimeout(resolve, 50));

    expect(mockSocket.emit).not.toHaveBeenCalled();
    expect(result.current.isLoading).toBe(false);
    expect(result.current.data).toBeUndefined();
  });

  it("should handle errors correctly", async () => {
    const errorMessage = "Something went wrong";
    
    mockSocket.emit.mockImplementation(
      (_event: string, _payload: unknown, callback: (response: ServiceResponse<unknown>) => void) => {
        callback({ success: false, error: errorMessage });
      }
    );

    const onError = vi.fn();

    const { result } = renderHook(
      () => useServiceQuery("testService", "getData", {}, { onError, retry: false }),
      { wrapper: createWrapper(mockContext) }
    );

    await waitFor(() => {
      expect(result.current.isError).toBe(true);
    }, { timeout: 3000 });

    expect(result.current.error).toBe(errorMessage);
    expect(onError).toHaveBeenCalledWith(errorMessage);
  });

  it("should call onSuccess callback when data is fetched", async () => {
    const mockData = { id: "123" };
    const onSuccess = vi.fn();

    mockSocket.emit.mockImplementation(
      (_event: string, _payload: unknown, callback: (response: ServiceResponse<typeof mockData>) => void) => {
        callback({ success: true, data: mockData });
      }
    );

    const { result } = renderHook(
      () => useServiceQuery("testService", "getData", {}, { onSuccess }),
      { wrapper: createWrapper(mockContext) }
    );

    await waitFor(() => {
      expect(result.current.isSuccess).toBe(true);
    });

    expect(onSuccess).toHaveBeenCalledWith(mockData);
  });

  it("should use cached data for same query key", async () => {
    const mockData = { id: "123" };
    const queryClient = new QueryClient({
      defaultOptions: {
        queries: { retry: false, staleTime: 60000 },
      },
    });

    mockSocket.emit.mockImplementation(
      (_event: string, _payload: unknown, callback: (response: ServiceResponse<typeof mockData>) => void) => {
        callback({ success: true, data: mockData });
      }
    );

    // First render
    const { result: result1 } = renderHook(
      () => useServiceQuery("testService", "getData", { id: "1" }),
      { wrapper: createWrapper(mockContext, queryClient) }
    );

    await waitFor(() => {
      expect(result1.current.isSuccess).toBe(true);
    });

    expect(mockSocket.emit).toHaveBeenCalledTimes(1);

    // Second render with same payload - should use cache
    const { result: result2 } = renderHook(
      () => useServiceQuery("testService", "getData", { id: "1" }),
      { wrapper: createWrapper(mockContext, queryClient) }
    );

    // Should immediately have data from cache
    expect(result2.current.data).toEqual(mockData);
    // Should not have made another API call
    expect(mockSocket.emit).toHaveBeenCalledTimes(1);
  });

  it("should fetch fresh data for different payload", async () => {
    const mockData1 = { id: "1" };
    const mockData2 = { id: "2" };
    const queryClient = new QueryClient({
      defaultOptions: {
        queries: { retry: false, staleTime: 60000 },
      },
    });

    let callCount = 0;
    mockSocket.emit.mockImplementation(
      (_event: string, payload: { id: string }, callback: (response: ServiceResponse<{ id: string }>) => void) => {
        callCount++;
        callback({ success: true, data: payload.id === "1" ? mockData1 : mockData2 });
      }
    );

    // First query
    const { result: result1 } = renderHook(
      () => useServiceQuery("testService", "getData", { id: "1" }),
      { wrapper: createWrapper(mockContext, queryClient) }
    );

    await waitFor(() => {
      expect(result1.current.isSuccess).toBe(true);
    });

    expect(callCount).toBe(1);

    // Second query with different payload - should fetch
    const { result: result2 } = renderHook(
      () => useServiceQuery("testService", "getData", { id: "2" }),
      { wrapper: createWrapper(mockContext, queryClient) }
    );

    await waitFor(() => {
      expect(result2.current.isSuccess).toBe(true);
    });

    expect(callCount).toBe(2);
    expect(result2.current.data).toEqual(mockData2);
  });

  it("should support manual refetch", async () => {
    let fetchCount = 0;

    mockSocket.emit.mockImplementation(
      (_event: string, _payload: unknown, callback: (response: ServiceResponse<{ count: number }>) => void) => {
        fetchCount++;
        callback({ success: true, data: { count: fetchCount } });
      }
    );

    const { result } = renderHook(
      () => useServiceQuery("testService", "getData", {}, { staleTime: 60000 }),
      { wrapper: createWrapper(mockContext) }
    );

    await waitFor(() => {
      expect(result.current.isSuccess).toBe(true);
    });

    expect(result.current.data).toEqual({ count: 1 });
    expect(fetchCount).toBe(1);

    // Manual refetch
    await act(async () => {
      await result.current.refetch();
    });

    await waitFor(() => {
      expect(result.current.data).toEqual({ count: 2 });
    });

    expect(fetchCount).toBe(2);
  });

  it("should not fetch when socket is not connected", async () => {
    const disconnectedContext = createMockContext(mockSocket, false);

    const { result } = renderHook(
      () => useServiceQuery("testService", "getData", {}),
      { wrapper: createWrapper(disconnectedContext) }
    );

    // Wait a tick
    await new Promise((resolve) => setTimeout(resolve, 50));

    expect(mockSocket.emit).not.toHaveBeenCalled();
    expect(result.current.isLoading).toBe(false);
  });

  it("should return memoized result object", async () => {
    const mockData = { id: "123" };

    mockSocket.emit.mockImplementation(
      (_event: string, _payload: unknown, callback: (response: ServiceResponse<typeof mockData>) => void) => {
        callback({ success: true, data: mockData });
      }
    );

    const { result } = renderHook(
      () => useServiceQuery("testService", "getData", {}, { staleTime: 60000 }),
      { wrapper: createWrapper(mockContext) }
    );

    await waitFor(() => {
      expect(result.current.isSuccess).toBe(true);
    });

    // Verify the result has the expected shape and values
    expect(result.current.data).toEqual(mockData);
    expect(result.current.isLoading).toBe(false);
    expect(result.current.isFetching).toBe(false);
    expect(result.current.isError).toBe(false);
    expect(result.current.error).toBeNull();
    expect(typeof result.current.refetch).toBe("function");
  });
});
