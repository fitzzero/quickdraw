// Peer links across two nodes behind a real Valkey (RFC 0003 section 12.5).
// A signal or a relay message for a socket of the other node goes out as a
// node event, and the node that holds the socket checks the room there
// before it delivers; a socket that disconnects, or that a call on the
// other node takes out of the room, says bye to its peers wherever they
// are; and two client links on two nodes open over the relay and carry
// messages both ways. `src/server/realtime/peers.test.ts` runs here too,
// with both sockets of a test on one node.

import { afterEach, describe, expect, it } from "vitest";
import { call } from "../../src/client/call";
import { createQuickdrawConnection, type QuickdrawConnection } from "../../src/client/connection";
import { until } from "../../src/client/__tests__/fixtures";
import { createPeerLink, onPeerRequest } from "../../src/client/peer/link";
import type { PeerLink } from "../../src/client/peer/types";
import { alice, bob, type AppPrincipal } from "../../src/server/__tests__/fixtures";
import {
  carol,
  defineLobbyService,
  GAME,
  message,
  OFFER,
  peerOf,
  settle,
  type Peer,
} from "../../src/server/realtime/__tests__/peers";
import { createTestApp, type TestApp } from "../../src/testing/index";
import { createBarrier, nodesOf } from "./nodes";

const apps: TestApp[] = [];
const connections: QuickdrawConnection[] = [];

afterEach(async () => {
  for (const connection of connections.splice(0)) {
    connection.close();
  }
  await Promise.all(apps.splice(0).map(async (app) => await app.close()));
});

/** Two nodes serving peer links, and a barrier from node A to node B. */
async function start() {
  const app = await createTestApp({ services: [defineLobbyService()], peers: true });
  apps.push(app as unknown as TestApp);
  const [a, b] = nodesOf(app);
  const nodeB = b.app as unknown as typeof app;
  return { app, nodeB, toB: createBarrier(a.app.server.io, b.app.server.io) };
}

type Cluster = Awaited<ReturnType<typeof start>>;

type Node = Cluster["app"];

/** A socket of `node` acting as `principal`, in app room `room` unless `null`. */
async function player(node: Node, principal: AppPrincipal, room: string | null = GAME) {
  const connection = await node.connect(principal);
  if (room !== null) {
    await connection.call.lobbyService.enter({ room });
  }
  return peerOf(connection);
}

/**
 * Waits until each node handled what its sockets sent, what it forwarded
 * reached the other node, and each socket received what its node sent it.
 */
async function delivered(cluster: Cluster, ...peers: readonly Peer[]): Promise<void> {
  await settle(...peers);
  await cluster.toB();
  // `settle` waits for node B's publications to reach node A first.
  await settle(...peers);
}

const ok = { ok: true };

const bye = (from: Peer, userId: string) => ({
  room: GAME,
  from: from.id,
  userId,
  sig: { bye: true },
});

describe("peer links across two nodes", () => {
  it("forward signals and relay messages, naming the sender's user, and the bye of a socket that disconnects", async () => {
    const cluster = await start();
    const a = await player(cluster.app, alice);
    const b = await player(cluster.nodeB, bob);
    expect(await a.signal(GAME, b.id, OFFER)).toEqual(ok);
    expect(await b.signal(GAME, a.id, { relay: true })).toEqual(ok);
    await delivered(cluster, a, b);
    expect(b.signals).toEqual([{ room: GAME, from: a.id, userId: "alice", sig: OFFER }]);
    expect(a.signals).toEqual([{ room: GAME, from: b.id, userId: "bob", sig: { relay: true } }]);
    for (let n = 0; n < 5; n += 1) {
      a.relay(GAME, b.id, "rel", message(n));
    }
    b.relay(GAME, a.id, "fast", message("back"));
    await delivered(cluster, a, b);
    expect(b.relayed).toEqual([0, 1, 2, 3, 4].map((n) => [GAME, a.id, "rel", message(n)]));
    expect(a.relayed).toEqual([[GAME, b.id, "fast", message("back")]]);
    b.connection.socket.disconnect();
    await expect.poll(() => a.signals.at(-1)).toEqual(bye(b, "bob"));
  });

  it("check the room on the node that holds the target, which drops what an outsider would get", async () => {
    const cluster = await start();
    const a = await player(cluster.app, alice);
    const outside = await player(cluster.nodeB, carol, null);
    // Node A cannot see the other node's rooms: it forwards, and node B refuses to deliver.
    expect(await a.signal(GAME, outside.id, OFFER)).toEqual(ok);
    a.relay(GAME, outside.id, "rel", message(1));
    await delivered(cluster, a, outside);
    expect([outside.signals, outside.relayed]).toEqual([[], []]);
  });

  it("end the links of a user a call on the other node takes out of the room", async () => {
    const cluster = await start();
    const a = await player(cluster.app, alice);
    const b = await player(cluster.nodeB, bob);
    expect(await b.signal(GAME, a.id, { relay: true })).toEqual(ok);
    // On node A: every node takes Bob's sockets out, and his node says his bye.
    await a.connection.call.lobbyService.kick({ room: GAME, userId: "bob" });
    await delivered(cluster, a, b);
    expect(a.signals).toEqual([
      { room: GAME, from: b.id, userId: "bob", sig: { relay: true } },
      bye(b, "bob"),
    ]);
    b.relay(GAME, a.id, "rel", message("gone"));
    await delivered(cluster, a, b);
    expect(a.relayed).toEqual([]);
  });
});

describe("client links across two nodes", () => {
  /** A client connection to `node` as `principal`, in `GAME`, accepting every link. */
  async function client(node: Node, principal: AppPrincipal) {
    const connection = createQuickdrawConnection({
      url: node.url,
      auth: { principal },
      transports: ["websocket"],
    });
    connections.push(connection);
    connection.open();
    await until(() => connection.getState().hello !== null);
    await call(connection, {
      service: "lobbyService",
      method: "enter",
      input: { room: GAME },
      kind: "mutation",
    });
    const accepted: PeerLink[] = [];
    onPeerRequest(connection, (request) => {
      accepted.push(request.accept());
    });
    return { connection, accepted, id: connection.socket.id ?? "" };
  }

  it("open over the relay, carry messages both ways in order, and close on both sides", async () => {
    const { app, nodeB } = await start();
    const ada = await client(app, alice);
    const bo = await client(nodeB, bob);
    const offered = createPeerLink(ada.connection, { room: GAME, to: bo.id, offerer: true });
    await until(() => offered.state === "open" && bo.accepted[0]?.state === "open");
    const answered = bo.accepted[0] as PeerLink;
    expect([offered.path, answered.path]).toEqual(["relay", "relay"]);
    expect([offered.userId, answered.userId]).toEqual(["bob", "alice"]);
    const atBo: unknown[] = [];
    const atAda: unknown[] = [];
    answered.on("message", (data) => atBo.push(data));
    offered.on("message", (data) => atAda.push(data));
    for (let n = 0; n < 5; n += 1) {
      offered.send("rel", { n });
    }
    answered.send("rel", "back");
    await until(() => atBo.length === 5 && atAda.length === 1);
    expect(atBo).toEqual([0, 1, 2, 3, 4].map((n) => ({ n })));
    expect(atAda).toEqual(["back"]);
    await until(() => offered.clock.synced && answered.clock.synced);
    offered.close();
    await until(() => answered.state === "closed");
    expect(answered.closeReason).toBe("bye");
  });
});
