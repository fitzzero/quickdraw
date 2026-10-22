// Peer links against a real server (RFC 0003 section 12.5): client
// connections over real sockets, in one app room of a server created with
// `peers: true`. Node has no `RTCPeerConnection`, so a link without an
// injected one runs on the relay; with the stand-in WebRTC of
// `__tests__/fakeRtc.ts`, which both sides in this process share, the
// server signals the direct path and relays nothing.

import { afterEach, describe, expect, it } from "vitest";
import type { Principal } from "../../server/index";
import { alice, bob } from "../../server/__tests__/fixtures";
import { carol, defineLobbyService, GAME } from "../../server/realtime/__tests__/peers";
import { createTestApp, type TestApp } from "../../testing/index";
import { call } from "../call";
import { createQuickdrawConnection, type QuickdrawConnection } from "../connection";
import { until } from "../__tests__/fixtures";
import { createPeerLink, onPeerRequest, type PeerLinkOptions } from "./link";
import type { PeerLink } from "./types";
import { createFakeNetwork } from "./__tests__/fakeRtc";

const apps: TestApp[] = [];
const connections: QuickdrawConnection[] = [];

afterEach(async () => {
  for (const connection of connections.splice(0)) {
    connection.close();
  }
  await Promise.all(apps.splice(0).map(async (app) => await app.close()));
});

async function start(peers = true) {
  const app = await createTestApp({ services: [defineLobbyService()], peers });
  apps.push(app as unknown as TestApp);
  return app;
}

type App = Awaited<ReturnType<typeof start>>;

function enter(connection: QuickdrawConnection, method: "enter" | "exit", room = GAME) {
  return call(connection, { service: "lobbyService", method, input: { room }, kind: "mutation" });
}

/** A client connection as `principal`, said hello to, in `GAME`, accepting every link with `accept`. */
async function player(
  app: App,
  principal: Principal,
  accept: Omit<PeerLinkOptions, "room" | "to" | "offerer"> = {},
) {
  const connection = createQuickdrawConnection({
    url: app.url,
    auth: { principal },
    transports: ["websocket"],
  });
  connections.push(connection);
  connection.open();
  await until(() => connection.getState().hello !== null);
  await enter(connection, "enter");
  const accepted: PeerLink[] = [];
  onPeerRequest(connection, (request) => {
    accepted.push(request.accept(accept));
  });
  const id = connection.socket.id ?? "";
  return { connection, accepted, id };
}

type Player = Awaited<ReturnType<typeof player>>;

function link(from: Player, to: Player, options: Partial<PeerLinkOptions> = {}): PeerLink {
  return createPeerLink(from.connection, { room: GAME, to: to.id, offerer: true, ...options });
}

function messagesOf(peer: PeerLink): [unknown, string][] {
  const into: [unknown, string][] = [];
  peer.on("message", (data, label) => into.push([data, label]));
  return into;
}

describe("peer links against a server", () => {
  it("run over the relay where there is no WebRTC, naming each other's users", async () => {
    const app = await start();
    const ada = await player(app, alice);
    const bo = await player(app, bob);
    const offered = link(ada, bo);
    await until(() => offered.state === "open" && bo.accepted[0]?.state === "open");
    const answered = bo.accepted[0] as PeerLink;
    expect([offered.path, answered.path]).toEqual(["relay", "relay"]);
    expect([offered.userId, answered.userId]).toEqual(["bob", "alice"]);
    const atBo = messagesOf(answered);
    const atAda = messagesOf(offered);
    for (let n = 0; n < 5; n += 1) {
      expect(offered.send("rel", { n })).toBe(true);
    }
    expect(answered.send("rel", "back")).toBe(true);
    await until(() => atBo.length === 5 && atAda.length === 1);
    expect(atBo).toEqual([0, 1, 2, 3, 4].map((n) => [{ n }, "rel"]));
    expect(atAda).toEqual([["back", "rel"]]);
    await until(() => offered.clock.synced && answered.clock.synced);
    expect(offered.clock.rtt).toBeGreaterThan(0);
    offered.close();
    await until(() => answered.state === "closed");
    expect(answered.closeReason).toBe("bye");
  });

  it("open the direct path the server signals, which then carries everything", async () => {
    const network = createFakeNetwork();
    const app = await start();
    const ada = await player(app, alice);
    const bo = await player(app, bob, { peerConnection: network.factory });
    const offered = link(ada, bo, { peerConnection: network.factory });
    await until(() => offered.state === "open" && bo.accepted[0]?.state === "open");
    expect([offered.path, bo.accepted[0]?.path]).toEqual(["direct", "direct"]);
    const atBo = messagesOf(bo.accepted[0] as PeerLink);
    offered.send("fast", "direct");
    await until(() => atBo.length === 1);
    await until(() => offered.clock.synced);
    expect(app.frames({ event: "qd:relay" })).toEqual([]);
    expect(app.frames({ event: "qd:peer" }).map((frame) => frame.userId)).toContain("bob");
  });

  it("move to the relay when ICE fails", async () => {
    const network = createFakeNetwork();
    network.mode = "fail";
    const app = await start();
    const ada = await player(app, alice);
    const bo = await player(app, bob, { peerConnection: network.factory });
    const offered = link(ada, bo, { peerConnection: network.factory });
    await until(() => offered.state === "open" && bo.accepted[0]?.state === "open");
    expect([offered.path, bo.accepted[0]?.path]).toEqual(["relay", "relay"]);
  });

  it("close when a player leaves the room, is taken out of it, or disconnects", async () => {
    const app = await start();
    const ada = await player(app, alice);
    const bo = await player(app, bob);
    const cy = await player(app, carol);
    const toBo = link(ada, bo);
    const toCy = link(ada, cy);
    const toCyAgain = link(bo, cy);
    await until(() => [toBo, toCy, toCyAgain].every((peer) => peer.state === "open"));
    const fromBo = cy.accepted.find((peer) => peer.peer === bo.id);
    const fromAda = cy.accepted.find((peer) => peer.peer === ada.id);
    // Bo leaves: his links close as left, and the server tells his peers bye.
    await enter(bo.connection, "exit");
    await until(() => [toBo, toCyAgain, fromBo].every((peer) => peer?.state === "closed"));
    expect([bo.accepted[0]?.closeReason, toCyAgain.closeReason]).toEqual(["left", "left"]);
    expect([toBo.closeReason, fromBo?.closeReason]).toEqual(["bye", "bye"]);
    // Cy's connection closes: Ada's link to her hears the server's bye for her socket.
    cy.connection.close();
    await until(() => toCy.state === "closed");
    expect([toCy.closeReason, fromAda?.closeReason]).toEqual(["bye", "disconnected"]);
  });

  it("are unsupported on a server without peers", async () => {
    const app = await start(false);
    const ada = await player(app, alice);
    const bo = await player(app, bob);
    const offered = link(ada, bo);
    await until(() => offered.state === "closed");
    expect(offered.closeReason).toBe("unsupported");
    expect(app.frames({ event: "qd:peer" })).toEqual([]);
  });
});
