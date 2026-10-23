// A host-served stream's feed in the stream store (host mode, RFC 0003
// section 12.5), against a host in process: a host that refuses the
// subscribe `RATE_LIMITED` is asked again a little later, the feed loading
// meanwhile, and a scope the server would refuse is refused here, with
// nothing sent. `../host/host.test.ts` runs feeds against a real server.

import { afterEach, describe, expect, it, vi } from "vitest";
import type { HostMessage } from "../../protocol/envelope";
import { MAX_SCOPE_LENGTH } from "../../protocol/version";
import { registerLocalHost } from "../host/links";
import { createLocalLink } from "../host/local";
import { controlOf, type LinkControl } from "../peer/core";
import { fakeConnection, testQueryClient } from "./__tests__/fakeSocket";
import { liveDataOf } from "./liveData";
import { feedKey, HOST_RETRY_MS, type StreamTarget } from "./streams";

const ROOM = "world:1";

const target: StreamTarget = {
  service: "gameService",
  stream: "world",
  scoped: true,
  host: () => ROOM,
};

afterEach(() => {
  vi.useRealTimers();
});

/** A connection whose socket hosts `ROOM`, over its in-process link: what its host hears, and how it answers. */
function hosted() {
  const fake = fakeConnection();
  (fake.connection.socket as { id?: string }).id = "socket-ada";
  const live = liveDataOf(fake.connection, testQueryClient());
  const heard: HostMessage[] = [];
  let host: LinkControl | undefined;
  registerLocalHost(
    fake.connection,
    ROOM,
    (link) => {
      host = controlOf(link);
      host?.on((message) => {
        heard.push(message);
      });
    },
    createLocalLink,
  );
  fake.deliver("qd:host", [ROOM, "socket-ada"]);
  const send = (message: HostMessage): void => {
    host?.send("rel", message);
  };
  return { live, heard, send };
}

describe("a host-served feed", () => {
  it("asks a host that refused it RATE_LIMITED again a little later, loading meanwhile", () => {
    vi.useFakeTimers();
    const { live, heard, send } = hosted();
    live.streams.hold(target, "w1", 10);
    expect(heard).toEqual([[4, "gameService", "world", "w1"]]);
    const error = {
      code: "RATE_LIMITED",
      message: "A peer subscribes at most 50 times a second",
    } as const;
    send([8, "gameService", "world", "w1", error]);
    const key = feedKey("gameService", "world", "w1");
    expect(live.streams.state(key)).toMatchObject({ isLoading: true, error: null });
    vi.advanceTimersByTime(HOST_RETRY_MS - 1);
    expect(heard).toHaveLength(1);
    vi.advanceTimersByTime(HOST_RETRY_MS / 2 + 1);
    expect(heard.slice(1)).toEqual([
      [5, "gameService", "world", "w1"],
      [4, "gameService", "world", "w1"],
    ]);
    send([6, "gameService", "world", "w1", [{ tick: 1 }], true]);
    expect(live.streams.state(key)).toMatchObject({
      items: [{ tick: 1 }],
      isLoading: false,
      error: null,
    });
  });

  it("refuses a scope the server would refuse, VALIDATION, and sends the host nothing", () => {
    const { live, heard } = hosted();
    const scope = "s".repeat(MAX_SCOPE_LENGTH + 1);
    live.streams.hold(target, scope, 10);
    expect(live.streams.state(feedKey("gameService", "world", scope))).toMatchObject({
      items: [],
      isLoading: false,
      error: expect.objectContaining({ code: "VALIDATION" }),
    });
    expect(heard).toEqual([]);
  });
});
