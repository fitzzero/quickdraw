// The in-process link between a host and its own client (`local.ts`, RFC
// 0003 section 12.5): both ends open at once and hand each other messages
// at once, closing one closes the other with `bye`, and a stall of this
// tab's timers (a hidden tab's) never closes it as `lost`.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { MAX_PEER_MESSAGE_BYTES } from "../../protocol/version";
import { PING_MS, WATCHDOG_MS } from "../peer/core";
import { createLocalLink } from "./local";

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "performance", "Date"] });
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.useRealTimers();
});

const local = () => createLocalLink("match:1", "socket-ada", "ada", () => MAX_PEER_MESSAGE_BYTES);

describe("the host's in-process link", () => {
  it("opens both ends at once and hands each message on at once", () => {
    const [near, far] = local();
    expect([near.state, near.path, far.state, far.path]).toEqual([
      "open",
      "direct",
      "open",
      "direct",
    ]);
    expect([near.userId, far.userId]).toEqual(["ada", "ada"]);
    const heard: unknown[] = [];
    far.on("message", (data) => heard.push(data));
    expect(near.send("rel", "to the host")).toBe(true);
    expect(heard).toEqual(["to the host"]);
  });

  it("closes the other end with bye", () => {
    const [near, far] = local();
    near.close();
    expect([near.closeReason, far.closeReason]).toEqual(["closed", "bye"]);
  });

  it("stays open when this tab's timers stall past the watchdog", () => {
    const [near, far] = local();
    vi.advanceTimersByTime(2000);
    // A hidden tab runs its timers once a minute: the clock moves on, and no ping goes meanwhile.
    const now = performance.now.bind(performance);
    vi.spyOn(performance, "now").mockImplementation(() => now() + WATCHDOG_MS * 8);
    vi.advanceTimersByTime(PING_MS * 2);
    expect([near.state, far.state]).toEqual(["open", "open"]);
  });
});
