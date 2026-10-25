// What the connection does with Socket.IO's send buffer (RFC 0003 sections
// 8.1 and 8.4): `failBuffered` takes the packets it picks out of it, and
// tells their acknowledgements. Over a socket that never connects, which
// keeps everything emitted on it in that buffer, with fake timers.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createSocket, failBuffered, type BufferedPacket } from "./socket";

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
});

/** The call id a buffered `qd:call` packet carries, or the event a buffered packet is. */
function named(packet: BufferedPacket): string {
  const [event, frame] = packet.data as [string, { readonly id?: number }];
  return event === "qd:call" ? `call ${String(frame.id)}` : event;
}

describe("failBuffered", () => {
  it("takes the packets it picks, tells each acknowledgement once, and ends their time limits", () => {
    // Made after the fake timers, so Socket.IO times the acknowledgements with them.
    const socket = createSocket({ url: "http://127.0.0.1:9" }, () => ({}));
    const told: string[] = [];
    for (const id of [1, 2]) {
      socket.timeout(5000).emit("qd:call", { id, s: "noteService", m: "save" }, (error) => {
        told.push(`${String(id)} ${error?.message ?? "answered"}`);
      });
    }
    socket.emit("qd:ch", ["roomService", "cursor", { x: 1 }]);
    expect(socket.sendBuffer.map(named)).toEqual(["call 1", "call 2", "qd:ch"]);
    expect(vi.getTimerCount()).toBe(2);

    expect(failBuffered(socket, new Error("taken"), (packet) => named(packet) === "call 1")).toBe(
      1,
    );
    expect(told).toEqual(["1 taken"]);
    expect(socket.sendBuffer.map(named)).toEqual(["call 2", "qd:ch"]);
    expect(vi.getTimerCount()).toBe(1);

    expect(failBuffered(socket, new Error("dropped"))).toBe(2);
    expect(told).toEqual(["1 taken", "2 dropped"]);
    expect(socket.sendBuffer).toEqual([]);
    expect(vi.getTimerCount()).toBe(0);
    vi.advanceTimersByTime(10_000);
    expect(told).toHaveLength(2);
    expect(failBuffered(socket, new Error("again"))).toBe(0);
  });
});
