import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, cleanup } from "@testing-library/react";
import * as React from "react";
import { QuickdrawProvider } from "./QuickdrawProvider";

const ioMock = vi.hoisted(() => vi.fn());

vi.mock("socket.io-client", () => ({
  io: ioMock,
}));

function createMockSocket() {
  return {
    on: vi.fn(),
    off: vi.fn(),
    emit: vi.fn(),
    disconnect: vi.fn(),
  };
}

function lastIoOptions(): Record<string, unknown> {
  const call = ioMock.mock.calls.at(-1);
  expect(call).toBeDefined();
  return (call?.[1] ?? {}) as Record<string, unknown>;
}

describe("QuickdrawProvider - socket transports", () => {
  beforeEach(() => {
    cleanup();
    ioMock.mockReset();
    ioMock.mockImplementation(() => createMockSocket());
  });

  it("defaults to websocket + polling (socket.io browser behavior)", () => {
    render(
      <QuickdrawProvider serverUrl="http://localhost:4000" authToken="token-1">
        <div />
      </QuickdrawProvider>,
    );

    expect(ioMock).toHaveBeenCalledTimes(1);
    expect(lastIoOptions().transports).toEqual(["websocket", "polling"]);
  });

  it("passes a custom transports list through to socket.io", () => {
    render(
      <QuickdrawProvider
        serverUrl="http://localhost:4000"
        authToken="token-1"
        transports={["websocket"]}
      >
        <div />
      </QuickdrawProvider>,
    );

    expect(ioMock).toHaveBeenCalledTimes(1);
    expect(lastIoOptions().transports).toEqual(["websocket"]);
  });

  it("keeps the custom transports on reconnect after an authToken change", () => {
    const { rerender } = render(
      <QuickdrawProvider
        serverUrl="http://localhost:4000"
        authToken="token-1"
        transports={["websocket"]}
      >
        <div />
      </QuickdrawProvider>,
    );

    rerender(
      <QuickdrawProvider
        serverUrl="http://localhost:4000"
        authToken="token-2"
        transports={["websocket"]}
      >
        <div />
      </QuickdrawProvider>,
    );

    // A token change tears down and reconnects (possibly more than once —
    // both the auto-connect and token-change effects react); every socket
    // must keep the custom transports, and the last one the new token.
    expect(ioMock.mock.calls.length).toBeGreaterThanOrEqual(2);
    for (const call of ioMock.mock.calls) {
      expect((call[1] as Record<string, unknown>).transports).toEqual(["websocket"]);
    }
    expect(lastIoOptions().auth).toEqual({ token: "token-2" });
  });
});
