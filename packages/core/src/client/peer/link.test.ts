// The peer link's state machine (RFC 0003 section 12.5), on fake timers: a
// stand-in server (`__tests__/fakeWire.ts`) forwards signals and relay
// messages, and a stand-in WebRTC network (`__tests__/fakeRtc.ts`) connects,
// fails or never connects the direct path. Covered: the direct path with
// its two pre-negotiated channels, the fallback to the relay (ICE failed,
// nothing open in time, a path that dropped after it opened, a side without
// WebRTC), every way a link closes, the limits `send` keeps, the requests of
// peers without a link, and the clock. `peer.test.ts` runs links against a
// real server.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { PeerSignalFrame } from "../../protocol/envelope";
import { MAX_PEER_MESSAGE_BYTES } from "../../protocol/version";
import { PING_MS, QUICK_PINGS, WATCHDOG_MS } from "./core";
import { DEFAULT_PEER_LIMITS, PENDING_MS } from "./hub";
import {
  createPeerLink,
  DEFAULT_ICE_SERVERS,
  DIRECT_TIMEOUT_MS,
  onPeerRequest,
  OPEN_TIMEOUT_MS,
  type PeerLinkOptions,
  type PeerRequest,
} from "./link";
import { DISCONNECTED_GRACE_MS, FAST_BACKLOG_BYTES } from "./rtc";
import type { PeerLink, PeerLinkEvents } from "./types";
import { createFakeNetwork, type FakeNetwork } from "./__tests__/fakeRtc";
import { helloOf, Wire, type ConnectOptions, type FakeConnection } from "./__tests__/fakeWire";

const ROOM = "match:1";

let wire: Wire;
let network: FakeNetwork;

beforeEach(() => {
  vi.useFakeTimers({
    toFake: ["setTimeout", "clearTimeout", "setInterval", "clearInterval", "performance", "Date"],
  });
  wire = new Wire();
  network = createFakeNetwork();
});

afterEach(() => {
  vi.useRealTimers();
});

/** Lets every timer due within `ms` run, and the promises they settle. */
async function pass(ms = 10): Promise<void> {
  await vi.advanceTimersByTimeAsync(ms);
}

/** What a link emitted, in order. */
function record(link: PeerLink) {
  const events: [keyof PeerLinkEvents, ...unknown[]][] = [];
  const messages: [unknown, string][] = [];
  link.on("open", (path) => events.push(["open", path]));
  link.on("state", (state, path) => events.push(["state", state, path]));
  link.on("close", (reason) => events.push(["close", reason]));
  link.on("message", (data, label) => messages.push([data, label]));
  return { events, messages };
}

interface Side {
  readonly side: FakeConnection;
  readonly requests: PeerRequest[];
  readonly accepted: PeerLink[];
}

/** A player whose connection accepts every request, with `accept` options. */
function player(
  userId: string,
  accept: Omit<PeerLinkOptions, "room" | "to" | "offerer"> | false = {},
  options: ConnectOptions = {},
): Side {
  const side = wire.connect(userId, options);
  const requests: PeerRequest[] = [];
  const accepted: PeerLink[] = [];
  onPeerRequest(side.connection, (request) => {
    requests.push(request);
    if (accept !== false) {
      accepted.push(request.accept(accept));
    }
  });
  return { side, requests, accepted };
}

function offer(from: Side, to: Side, options: Partial<PeerLinkOptions> = {}): PeerLink {
  return createPeerLink(from.side.connection, {
    room: ROOM,
    to: to.side.socket.id,
    offerer: true,
    ...options,
  });
}

describe("both sides offering", () => {
  it("opens one link: the side whose socket id sorts after the other's answers", async () => {
    const ada = player("ada", false);
    const bo = player("bo", false);
    const first = offer(ada, bo, { peerConnection: network.factory });
    const second = offer(bo, ada, { peerConnection: network.factory });
    await pass();
    expect([first.state, first.path, second.state, second.path]).toEqual([
      "open",
      "direct",
      "open",
      "direct",
    ]);
    // Bo's socket id sorts after Ada's: his offer's connection closed, and he answered.
    const [adaRtc, boOffer, boAnswer] = network.made;
    expect([adaRtc?.closed, boOffer?.closed, boAnswer?.closed]).toEqual([false, true, false]);
    expect(
      bo.side.socket
        .signals()
        .map((sig) => sig.sdp?.type)
        .filter(Boolean),
    ).toEqual(["offer", "answer"]);
    const heard = record(second);
    first.send("rel", "one link");
    await pass();
    expect(heard.messages).toEqual([["one link", "rel"]]);
    expect([ada.requests, bo.requests]).toEqual([[], []]);
  });

  it("moves to the relay when the side that cannot go direct offered too", async () => {
    const ada = player("ada", false);
    const bo = player("bo", false);
    const direct = offer(ada, bo, { peerConnection: network.factory });
    const relayed = offer(bo, ada, { relay: "always" });
    await pass();
    expect([direct.state, direct.path, relayed.state, relayed.path]).toEqual([
      "open",
      "relay",
      "open",
      "relay",
    ]);
    expect(network.made.map((rtc) => rtc.closed)).toEqual([true]);
  });
});

describe("the direct path", () => {
  it("opens over two pre-negotiated channels, and carries rel and fast both ways", async () => {
    const ada = player("ada");
    const bo = player("bo", { peerConnection: network.factory });
    const link = offer(ada, bo, { peerConnection: network.factory });
    const seen = record(link);
    expect(link.state).toBe("connecting");
    await pass();
    const [answer] = bo.accepted;
    expect([link.state, link.path, answer?.state, answer?.path]).toEqual([
      "open",
      "direct",
      "open",
      "direct",
    ]);
    expect(seen.events).toEqual([
      ["open", "direct"],
      ["state", "open", "direct"],
    ]);
    const [offerRtc, answerRtc] = network.made;
    expect(offerRtc?.configuration.iceServers).toEqual(DEFAULT_ICE_SERVERS);
    for (const rtc of [offerRtc, answerRtc]) {
      expect(
        [...(rtc?.channels.values() ?? [])].map((c) => [c.label, c.init, c.binaryType]),
      ).toEqual([
        ["rel", { negotiated: true, id: 0, ordered: true }, "arraybuffer"],
        ["fast", { negotiated: true, id: 1, ordered: false, maxRetransmits: 0 }, "arraybuffer"],
      ]);
    }
    // The offer and the answer, each side's candidate: nothing through the relay.
    expect(ada.side.socket.signals()).toEqual([
      { sdp: { type: "offer", sdp: `offer:${String(offerRtc?.id)}` } },
      { ice: { candidate: `candidate:${String(offerRtc?.id)}`, sdpMid: "0", sdpMLineIndex: 0 } },
    ]);
    expect(bo.side.socket.signals().map((sig) => Object.keys(sig)[0])).toEqual(["sdp", "ice"]);
    const answerSeen = record(answer as PeerLink);
    expect(link.send("rel", { hello: "bo" })).toBe(true);
    expect(link.send("fast", [1, 2])).toBe(true);
    expect(answer?.send("rel", "hi ada")).toBe(true);
    await pass();
    expect(answerSeen.messages).toEqual([
      [{ hello: "bo" }, "rel"],
      [[1, 2], "fast"],
    ]);
    expect(seen.messages).toEqual([["hi ada", "rel"]]);
    expect(link.stats).toEqual({ sent: 2, received: 1, dropped: 0 });
    expect(ada.side.socket.sent.filter(([event]) => event === "qd:relay")).toEqual([]);
  });

  it("names the peer's user as the server did", async () => {
    const ada = player("ada");
    const bo = player("bo", { peerConnection: network.factory });
    const link = offer(ada, bo, { peerConnection: network.factory });
    await pass();
    expect([link.userId, bo.accepted[0]?.userId]).toEqual(["bo", "ada"]);
    expect(bo.requests.map(({ room, from, userId }) => ({ room, from, userId }))).toEqual([
      { room: ROOM, from: ada.side.socket.id, userId: "ada" },
    ]);
  });

  it("keeps candidates that arrive before the offer until the offer is applied", async () => {
    const ada = player("ada");
    const bo = player("bo", false);
    // Bo makes his answering link before any signal: Ada's candidate may still come first.
    const answer = createPeerLink(bo.side.connection, {
      room: ROOM,
      to: ada.side.socket.id,
      offerer: false,
      peerConnection: network.factory,
    });
    await pass();
    bo.side.socket.receive("qd:peer", {
      room: ROOM,
      from: ada.side.socket.id,
      userId: "ada",
      sig: { ice: { candidate: "candidate:early" } },
    });
    const link = offer(ada, bo, { peerConnection: network.factory });
    await pass();
    expect([link.path, answer.path]).toEqual(["direct", "direct"]);
    // Ada's link made the first connection; Bo's, on her offer, the second.
    const [offerRtc, answerRtc] = network.made;
    expect(answerRtc?.candidates.map((c) => c.candidate)).toEqual([
      "candidate:early",
      `candidate:${String(offerRtc?.id)}`,
    ]);
  });

  it("drops fast messages while the channel is backed up, never rel ones", async () => {
    const ada = player("ada");
    const bo = player("bo", { peerConnection: network.factory });
    const link = offer(ada, bo, { peerConnection: network.factory });
    await pass();
    const fast = network.made[0]?.channels.get("fast");
    if (fast === undefined) {
      throw new Error("no fast channel");
    }
    fast.bufferedAmount = FAST_BACKLOG_BYTES + 1;
    expect(link.send("fast", 1)).toBe(false);
    expect(link.send("rel", 2)).toBe(true);
    fast.bufferedAmount = 0;
    expect(link.send("fast", 3)).toBe(true);
    expect(link.stats).toMatchObject({ sent: 2, dropped: 1 });
  });
});

describe("the relay", () => {
  it("carries the link when ICE fails, both sides moving to it", async () => {
    network.mode = "fail";
    const ada = player("ada");
    const bo = player("bo", { peerConnection: network.factory });
    const link = offer(ada, bo, { peerConnection: network.factory });
    await pass();
    const [answer] = bo.accepted;
    expect([link.state, link.path, answer?.path]).toEqual(["open", "relay", "relay"]);
    expect(ada.side.socket.signals().at(-1)).toEqual({ relay: true });
    expect(bo.side.socket.signals().at(-1)).toEqual({ relay: true });
    const seen = record(answer as PeerLink);
    link.send("rel", "over the relay");
    await pass();
    expect(seen.messages).toEqual([["over the relay", "rel"]]);
    expect(ada.side.socket.sent.filter(([event]) => event === "qd:relay").at(-1)).toEqual([
      "qd:relay",
      [ROOM, bo.side.socket.id, "rel", JSON.stringify([0, "over the relay"])],
    ]);
  });

  it(`carries it when no direct path opens within ${String(DIRECT_TIMEOUT_MS)} ms`, async () => {
    network.mode = "never";
    const ada = player("ada");
    const bo = player("bo", { peerConnection: network.factory });
    const link = offer(ada, bo, { peerConnection: network.factory });
    await pass();
    expect(link.state).toBe("connecting");
    await pass(DIRECT_TIMEOUT_MS);
    expect([link.path, bo.accepted[0]?.path]).toEqual(["relay", "relay"]);
  });

  it("takes an open link over when the direct path drops, and says so", async () => {
    const ada = player("ada");
    const bo = player("bo", { peerConnection: network.factory });
    const link = offer(ada, bo, { peerConnection: network.factory });
    await pass();
    const seen = record(link);
    network.made[0]?.setIce("disconnected");
    await pass(DISCONNECTED_GRACE_MS - 100);
    expect(link.path).toBe("direct");
    await pass(200);
    expect([link.state, link.path, bo.accepted[0]?.path]).toEqual(["open", "relay", "relay"]);
    expect(seen.events).toEqual([["state", "open", "relay"]]);
    const answerSeen = record(bo.accepted[0] as PeerLink);
    link.send("fast", "still here");
    await pass();
    expect(answerSeen.messages).toEqual([["still here", "fast"]]);
  });

  it("keeps a direct path that recovers within the grace", async () => {
    const ada = player("ada");
    const bo = player("bo", { peerConnection: network.factory });
    const link = offer(ada, bo, { peerConnection: network.factory });
    await pass();
    network.made[0]?.setIce("disconnected");
    await pass(DISCONNECTED_GRACE_MS / 2);
    network.made[0]?.setIce("connected");
    await pass(DISCONNECTED_GRACE_MS);
    expect(link.path).toBe("direct");
  });

  it("is used at once by a side without WebRTC, and by one that says always", async () => {
    for (const options of [{}, { peerConnection: network.factory, relay: "always" as const }]) {
      const ada = player(`ada-${String(network.made.length)}`);
      const bo = player(`bo-${String(network.made.length)}`, { peerConnection: network.factory });
      const link = offer(ada, bo, options);
      await pass();
      expect([link.path, bo.accepted[0]?.path]).toEqual(["relay", "relay"]);
      expect(ada.side.socket.signals()).toEqual([{ relay: true }]);
    }
    expect(network.made).toEqual([]);
  });

  it("is used when the answering side has no WebRTC", async () => {
    const ada = player("ada");
    const bo = player("bo");
    const link = offer(ada, bo, { peerConnection: network.factory });
    await pass();
    expect([link.path, bo.accepted[0]?.path]).toEqual(["relay", "relay"]);
    expect(network.made).toHaveLength(1);
    expect(network.made[0]?.closed).toBe(true);
  });

  it("stays within nine tenths of the announced rate and half the burst", async () => {
    const peers = { ...DEFAULT_PEER_LIMITS, relayRate: 10, relayBurst: 8 };
    const ada = player("ada", {}, { peers });
    const bo = player("bo", {}, { peers });
    const link = offer(ada, bo);
    await pass();
    // The pings took two of the four tokens; the rate gives one back every 111 ms.
    const sent = [1, 2, 3, 4].map((n) => link.send("rel", n));
    expect(sent.filter(Boolean).length).toBeLessThanOrEqual(2);
    expect(link.stats.dropped).toBeGreaterThanOrEqual(2);
    await pass(1000);
    expect(link.send("rel", 5)).toBe(true);
  });
});

describe("closing", () => {
  it("closes both sides: closed here, bye there, and the server hears bye", async () => {
    const ada = player("ada");
    const bo = player("bo");
    const link = offer(ada, bo);
    await pass();
    const seen = record(link);
    const answerSeen = record(bo.accepted[0] as PeerLink);
    link.close();
    link.close();
    await pass();
    expect([link.state, link.closeReason, link.path]).toEqual(["closed", "closed", undefined]);
    expect(bo.accepted[0]?.closeReason).toBe("bye");
    expect(seen.events).toEqual([
      ["state", "closed", undefined],
      ["close", "closed"],
    ]);
    expect(answerSeen.events.at(-1)).toEqual(["close", "bye"]);
    expect(ada.side.socket.signals().at(-1)).toEqual({ bye: true });
    // Bo's side sent no bye of its own: it was told.
    expect(bo.side.socket.signals()).not.toContainEqual({ bye: true });
    expect(link.send("rel", "late")).toBe(false);
  });

  it("closes as left when this socket leaves the room, and as disconnected when it drops", async () => {
    const ada = player("ada");
    const bo = player("bo");
    const link = offer(ada, bo);
    await pass();
    ada.side.socket.receive("qd:presence", { room: "elsewhere", users: [] });
    ada.side.socket.receive("qd:presence", { room: ROOM, users: ["ada"] });
    expect(link.state).toBe("open");
    ada.side.socket.receive("qd:presence", { room: ROOM, users: [] });
    expect(link.closeReason).toBe("left");
    // The server would have told Bo (it says bye for a socket that left): here he missed it.
    expect(bo.accepted[0]?.state).toBe("open");
    const again = offer(ada, bo);
    await pass();
    // Ada's second hello tells Bo his link is stale: it ends, and a new one answers.
    expect([bo.accepted[0]?.closeReason, bo.accepted[1]?.state, again.state]).toEqual([
      "bye",
      "open",
      "open",
    ]);
    bo.side.drop();
    expect(bo.accepted[1]?.closeReason).toBe("disconnected");
  });

  it(`closes as timeout when nothing opens within ${String(OPEN_TIMEOUT_MS)} ms, and says bye`, async () => {
    const ada = player("ada");
    const bo = player("bo", false);
    const link = offer(ada, bo, { relay: "always" });
    await pass(OPEN_TIMEOUT_MS - 100);
    expect(link.state).toBe("connecting");
    expect(bo.requests).toHaveLength(1);
    await pass(200);
    expect(link.closeReason).toBe("timeout");
    expect(ada.side.socket.signals()).toEqual([{ relay: true }, { bye: true }]);
  });

  it(`closes as lost when it hears nothing for ${String(WATCHDOG_MS)} ms`, async () => {
    const ada = player("ada");
    const bo = player("bo");
    const link = offer(ada, bo);
    await pass();
    wire.deaf.add(ada.side.socket.id);
    await pass(WATCHDOG_MS - PING_MS);
    expect(link.state).toBe("open");
    await pass(PING_MS * 2);
    expect(link.closeReason).toBe("lost");
    // Bo still heard Ada's pings until her bye reached him.
    expect(bo.accepted[0]?.closeReason).toBe("bye");
  });

  it("closes as refused when the server refuses a signal, and says bye, freeing the server's place", async () => {
    wire.answer = () => ({ ok: false, e: { code: "NOT_FOUND", message: "No such socket" } });
    const ada = player("ada");
    const bo = player("bo");
    const link = offer(ada, bo);
    await pass();
    expect(link.closeReason).toBe("refused");
    expect(ada.side.socket.signals()).toEqual([{ relay: true }, { bye: true }]);
  });

  it("retries a signal the server rate-limited", async () => {
    let refusals = 1;
    wire.answer = () =>
      refusals-- > 0
        ? {
            ok: false,
            e: { code: "RATE_LIMITED", message: "Slow down", data: { retryAfterMs: 50 } },
          }
        : { ok: true };
    const ada = player("ada");
    const bo = player("bo");
    const link = offer(ada, bo);
    await pass(100);
    expect(link.path).toBe("relay");
    expect(ada.side.socket.signals()).toEqual([{ relay: true }, { relay: true }]);
  });

  it("sends no signal again once the link closed, by this side or by its timeout", async () => {
    // The socket's rate limiter may ask for up to a minute.
    wire.answer = (_from, frame) =>
      frame.sig.bye === true
        ? { ok: true }
        : {
            ok: false,
            e: { code: "RATE_LIMITED", message: "Slow down", data: { retryAfterMs: 60_000 } },
          };
    const ada = player("ada");
    const bo = player("bo");
    const link = offer(ada, bo);
    await pass();
    link.close();
    await pass(60_000);
    expect(ada.side.socket.signals()).toEqual([{ relay: true }, { bye: true }]);
    const cy = player("cy");
    const again = offer(cy, bo);
    await pass(60_000);
    expect(again.closeReason).toBe("timeout");
    expect(cy.side.socket.signals()).toEqual([{ relay: true }, { bye: true }]);
  });

  it("closes as failed when a direct-only link's path fails", async () => {
    network.mode = "fail";
    const cy = player("cy");
    const di = player("di", { peerConnection: network.factory, relay: "never" });
    const direct = offer(cy, di, { peerConnection: network.factory, relay: "never" });
    await pass();
    // Both sides see ICE fail.
    expect([direct.closeReason, di.accepted[0]?.closeReason]).toEqual(["failed", "failed"]);
  });

  it("closes as unsupported on a server without peer links, or with neither path", async () => {
    const ada = player("ada", {}, { features: [] });
    const bo = player("bo");
    const link = offer(ada, bo);
    const seen = record(link);
    expect(link.state).toBe("connecting");
    await pass();
    expect(seen.events.at(-1)).toEqual(["close", "unsupported"]);
    expect(offer(bo, ada, { relay: "never" }).state).toBe("connecting");
    await pass();
    expect(ada.side.socket.sent).toEqual([]);
    expect(bo.side.socket.sent).toEqual([]);
  });

  it("waits for the hello, and ends with the connection", async () => {
    const ada = player("ada", {}, { ready: false });
    const bo = player("bo");
    const link = offer(ada, bo);
    await pass();
    expect(ada.side.socket.sent).toEqual([]);
    ada.side.setState({ status: "connected", hello: helloOf("ada") });
    await pass();
    expect(link.path).toBe("relay");
    const idle = player("cy", {}, { ready: false });
    const gone = offer(idle, bo);
    idle.side.setState({ status: "idle" });
    await pass();
    expect(gone.closeReason).toBe("disconnected");
  });
});

describe("send", () => {
  it("throws for a message over the size, and for a label it does not know", async () => {
    const ada = player("ada");
    const bo = player("bo");
    const link = offer(ada, bo);
    await pass();
    expect(() => link.send("rel", "x".repeat(MAX_PEER_MESSAGE_BYTES))).toThrow(RangeError);
    expect(() => link.send("loud" as "rel", 1)).toThrow(TypeError);
    expect(() => link.on("nope" as "open", () => undefined)).toThrow(TypeError);
  });

  it("drops what is sent before the link opens", () => {
    const ada = player("ada");
    const bo = player("bo");
    const link = offer(ada, bo);
    expect(link.send("rel", 1)).toBe(false);
    expect(link.stats).toEqual({ sent: 0, received: 0, dropped: 1 });
  });
});

describe("requests", () => {
  it("refuses a second link to the same peer in the same room", async () => {
    const ada = player("ada");
    const bo = player("bo");
    const link = offer(ada, bo);
    expect(() => offer(ada, bo)).toThrow(TypeError);
    expect(() => offer(ada, bo, { room: "match:2" })).not.toThrow();
    link.close();
    await pass();
    expect(() => offer(ada, bo)).not.toThrow();
  });

  it("keeps at most 64 KiB of a waiting peer's signals for the link that answers it", async () => {
    network.mode = "never";
    const bo = player("bo", false);
    const from = "socket-of-ada";
    const forward = (sig: unknown): void => {
      bo.side.socket.receive("qd:peer", { room: ROOM, from, userId: "ada", sig });
    };
    forward({ sdp: { type: "offer", sdp: "o".repeat(16_000) } });
    for (let n = 0; n < 60; n += 1) {
      forward({
        ice: { candidate: `${String(n).padStart(2, "0")}${"c".repeat(997)}`, sdpMid: "0" },
      });
    }
    expect(bo.requests.map((request) => request.from)).toEqual([from]);
    const link = bo.requests[0]?.accept({ peerConnection: network.factory });
    await pass();
    expect(link?.state).toBe("connecting");
    // The offer and 49 candidates of 1,000 characters fit; the rest were dropped.
    const [answerRtc] = network.made;
    expect(answerRtc?.candidates.length).toBe(49);
    expect(answerRtc?.candidates.at(-1)?.candidate.slice(0, 2)).toBe("48");
  });

  it("reject says bye, and a request nobody answers is dropped after a while", async () => {
    const ada = player("ada");
    const bo = player("bo", false);
    const link = offer(ada, bo);
    await pass();
    bo.requests[0]?.reject();
    await pass();
    expect(link.closeReason).toBe("bye");
    const cy = player("cy");
    const late = offer(cy, bo, { relay: "always" });
    await pass(PENDING_MS + 100);
    // Answered after the signals expired: Bo's link never hears Cy's relay, and waits.
    const answer = createPeerLink(bo.side.connection, {
      room: ROOM,
      to: cy.side.socket.id,
      offerer: false,
    });
    await pass();
    expect([late.state, answer.state]).toEqual(["closed", "connecting"]);
  });

  it("validates its options", () => {
    const ada = player("ada");
    const base = { room: ROOM, to: "socket-of-bo", offerer: true };
    for (const options of [
      { ...base, room: "" },
      { ...base, to: "" },
      { ...base, offerer: "yes" },
      { ...base, relay: "sometimes" },
      { ...base, peerConnection: {} },
    ]) {
      expect(() =>
        createPeerLink(ada.side.connection, options as unknown as PeerLinkOptions),
      ).toThrow(TypeError);
    }
  });
});

describe("the clock", () => {
  it("pings quickly on open, then every half second, and syncs", async () => {
    const ada = player("ada");
    const bo = player("bo");
    const link = offer(ada, bo);
    await pass();
    const pings = (): number =>
      ada.side.socket.sent.filter(
        ([event, frame]) =>
          event === "qd:relay" && (frame as readonly string[])[3]?.startsWith("[1,") === true,
      ).length;
    expect(pings()).toBe(1);
    await pass(80 * (QUICK_PINGS - 1));
    expect(pings()).toBe(QUICK_PINGS);
    expect(link.clock.synced).toBe(true);
    await pass(PING_MS);
    expect(pings()).toBe(QUICK_PINGS + 1);
    // One process, one clock: the peer's is this one's.
    expect(Math.abs(link.clock.offset)).toBeLessThan(1);
    expect(Math.abs(link.clock.now() - performance.now())).toBeLessThan(1);
    expect(link.clock.rtt).toBeGreaterThanOrEqual(0);
  });

  it("signals reach the server with the frame shape it reads", async () => {
    const ada = player("ada");
    const bo = player("bo");
    offer(ada, bo);
    await pass();
    const [event, frame] = ada.side.socket.sent[0] ?? [];
    expect(event).toBe("qd:peer");
    expect(frame).toEqual<PeerSignalFrame>({
      room: ROOM,
      to: bo.side.socket.id,
      sig: { relay: true },
    });
  });
});
