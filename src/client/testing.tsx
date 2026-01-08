import * as React from "react";
import type { QueryClient } from "@tanstack/react-query";
import type { Socket } from "socket.io-client";
import type { ServiceResponse } from "../shared/types";
import type { QuickdrawSocketContextValue } from "./types";

// Generic mock function type that works with both Jest and Vitest
type MockFn = (...args: unknown[]) => unknown;

/**
 * Mock socket for testing client components.
 */
export interface MockSocket {
  id: string;
  connected: boolean;
  emit: MockFn;
  on: MockFn;
  off: MockFn;
  disconnect: MockFn;
}

/**
 * Create a mock socket for testing.
 */
export function createMockSocket(): MockSocket {
  // Simple mock function that can be enhanced by the test framework
  const createMock = (): MockFn => {
    const fn: MockFn = () => undefined;
    return fn;
  };

  return {
    id: "mock-socket-id",
    connected: true,
    emit: createMock(),
    on: createMock(),
    off: createMock(),
    disconnect: createMock(),
  };
}

/**
 * Create a mock QuickdrawSocketContextValue for testing.
 */
export function createMockSocketContext(
  overrides: Partial<QuickdrawSocketContextValue> = {}
): QuickdrawSocketContextValue {
  const mockSocket = createMockSocket();

  return {
    socket: mockSocket as unknown as Socket,
    isConnected: true,
    userId: "test-user-id",
    serviceAccess: {},
    connect: () => {},
    disconnect: () => {},
    ...overrides,
  };
}

/**
 * Mock socket emit that resolves with a successful response.
 */
export function mockSuccessEmit<T>(data: T): (
  _event: string,
  _payload: unknown,
  callback?: (response: ServiceResponse<T>) => void
) => void {
  return (_event, _payload, callback) => {
    callback?.({ success: true, data });
  };
}

/**
 * Mock socket emit that resolves with an error response.
 */
export function mockErrorEmit(
  error: string,
  code?: number
): (
  _event: string,
  _payload: unknown,
  callback?: (response: ServiceResponse<unknown>) => void
) => void {
  return (_event, _payload, callback) => {
    const response: ServiceResponse<unknown> = { success: false, error };
    if (code !== undefined) {
      (response as { success: false; error: string; code: number }).code = code;
    }
    callback?.(response);
  };
}

/**
 * Create a mock QueryClient for testing.
 */
export function createMockQueryClient(): QueryClient {
  // Dynamic import to avoid bundling issues
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const { QueryClient } = require("@tanstack/react-query") as {
    QueryClient: new (options?: unknown) => QueryClient;
  };

  return new QueryClient({
    defaultOptions: {
      queries: {
        retry: false,
        gcTime: 0,
      },
      mutations: {
        retry: false,
      },
    },
  });
}

/**
 * Test wrapper component that provides the necessary context.
 */
export interface TestWrapperProps {
  children: React.ReactNode;
  socketContext?: Partial<QuickdrawSocketContextValue>;
  queryClient?: QueryClient;
}

/**
 * Create a test wrapper for rendering components with quickdraw context.
 *
 * @example
 * ```tsx
 * import { render } from '@testing-library/react';
 * import { createTestWrapper, createMockSocketContext, mockSuccessEmit } from '@quickdraw/core/client/testing';
 *
 * test('creates chat', async () => {
 *   const mockSocket = createMockSocket();
 *   mockSocket.emit.mockImplementation(mockSuccessEmit({ id: 'chat-123' }));
 *
 *   const wrapper = createTestWrapper({
 *     socketContext: { socket: mockSocket },
 *   });
 *
 *   const { getByText } = render(<CreateChatButton />, { wrapper });
 *   // ...
 * });
 * ```
 */
export function createTestWrapper(
  options: Omit<TestWrapperProps, "children"> = {}
): ({ children }: { children: React.ReactNode }) => React.ReactElement {
  const socketContext = createMockSocketContext(options.socketContext);
  const queryClient = options.queryClient ?? createMockQueryClient();

  // Create context for testing
  const QuickdrawSocketContext = React.createContext<QuickdrawSocketContextValue | null>(null);

  return function TestWrapper({ children }: { children: React.ReactNode }): React.ReactElement {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const { QueryClientProvider } = require("@tanstack/react-query") as {
      QueryClientProvider: React.ComponentType<{ client: QueryClient; children: React.ReactNode }>;
    };

    return (
      <QueryClientProvider client={queryClient}>
        <QuickdrawSocketContext.Provider value={socketContext}>
          {children}
        </QuickdrawSocketContext.Provider>
      </QueryClientProvider>
    );
  };
}
