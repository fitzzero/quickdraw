// The direct path on its own (RFC 0003 section 12.5), against the stand-in
// WebRTC of `__tests__/fakeRtc.ts`: a negotiation step that throws fails
// it, a channel that closes fails it, and closing it fires nothing.
// `link.test.ts` runs it inside links.

import { describe, expect, it, vi } from "vitest";
import type { PeerSignal } from "../../protocol/envelope";
import { createDirectPath, type DirectEvents } from "./rtc";
import { createFakeNetwork } from "./__tests__/fakeRtc";

function events() {
  const signals: PeerSignal[] = [];
  const seen: string[] = [];
  const handlers: DirectEvents = {
    signal: (sig) => signals.push(sig),
    opened: () => seen.push("opened"),
    failed: () => seen.push("failed"),
    message: () => seen.push("message"),
  };
  return { signals, seen, handlers };
}

describe("the direct path", () => {
  it("fails when a step of the negotiation throws, and closes its connection", async () => {
    const network = createFakeNetwork();
    const rtc = network.factory({ iceServers: [] });
    rtc.createOffer = () => Promise.reject(new Error("no codecs"));
    const { seen, handlers } = events();
    const direct = createDirectPath(rtc, handlers);
    direct.offer();
    await vi.waitFor(() => {
      expect(seen).toEqual(["failed"]);
    });
    expect(rtc.closed).toBe(true);
    expect(direct.send("rel", "x")).toBe(false);
  });

  it("fails when a channel closes, once, and fires nothing after its own close", () => {
    const network = createFakeNetwork();
    const first = network.factory({ iceServers: [] });
    const a = events();
    createDirectPath(first, a.handlers);
    first.channels.get("rel")?.close();
    first.channels.get("fast")?.close();
    expect(a.seen).toEqual(["failed"]);
    const second = network.factory({ iceServers: [] });
    const b = events();
    const direct = createDirectPath(second, b.handlers);
    direct.close();
    second.setIce("failed");
    expect(b.seen).toEqual([]);
    expect(second.closed).toBe(true);
  });
});
