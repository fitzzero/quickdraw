// When a client's way to the server is backed up (`backlog.ts`): 64 packets
// waiting for engine.io's transport, or more than 32 KiB unsent in its
// WebSocket; a socket with no engine, or a transport with no WebSocket (long
// polling), counts its packets only.

import { describe, expect, it } from "vitest";
import { FAST_BACKLOG_BYTES, PEER_RELAY_FAST_BACKLOG } from "../protocol/version";
import { backedUp, type EngineView } from "./backlog";
import type { QuickdrawSocket } from "./socket";

const socketOf = (engine?: EngineView): QuickdrawSocket =>
  ({ io: { engine } }) as unknown as QuickdrawSocket;

const waiting = (packets: number): EngineView => ({ writeBuffer: Array.from({ length: packets }) });

const unsent = (bytes: number): EngineView => ({
  writeBuffer: [],
  transport: { ws: { bufferedAmount: bytes } },
});

describe("backedUp", () => {
  it("is true once 64 packets wait for the transport", () => {
    expect(PEER_RELAY_FAST_BACKLOG).toBe(64);
    expect(backedUp(socketOf(waiting(63)))).toBe(false);
    expect(backedUp(socketOf(waiting(64)))).toBe(true);
  });

  it("is true once the WebSocket holds more than 32 KiB unsent", () => {
    expect(FAST_BACKLOG_BYTES).toBe(32_768);
    expect(backedUp(socketOf(unsent(32_768)))).toBe(false);
    expect(backedUp(socketOf(unsent(32_769)))).toBe(true);
  });

  it("reads no engine, no WebSocket or no count as nothing waiting", () => {
    expect(backedUp(socketOf())).toBe(false);
    expect(backedUp({} as QuickdrawSocket)).toBe(false);
    expect(backedUp(socketOf({ transport: {} }))).toBe(false);
    expect(backedUp(socketOf({ transport: { ws: { bufferedAmount: "lots" } } }))).toBe(false);
  });
});
