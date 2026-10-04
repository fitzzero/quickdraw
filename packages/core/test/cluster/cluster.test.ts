// Two nodes behind Valkey (pack H, child 2), beyond what the split suites
// show: revisions that compare across nodes, a quiet node answering a
// client that holds newer frames from the other node, writes to one row on
// both nodes whose frames arrive out of order, a resume on the other node,
// logout everywhere, a removal no scope could be named for reaching
// subscribers on both nodes, a channel's app room requirement checked on
// the sending socket's own node, and a stream's seed on a node that started
// after the pushes (kept seeds are per node; a computed one is not). Clients
// connect to node A (`app.connect`), or to node B through `nodesOf(app)`;
// writes go through node B.

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import {
  applyEntityFrame,
  applyEntityResult,
  type EntityEntry,
} from "../../src/client/live/entities";
import type { EntityFrame, EntityResult, PresenceFrame } from "../../src/index";
import { createHarness, type Harness } from "../../src/prisma/__tests__/harness";
import { deferred } from "../../src/server/__tests__/fixtures";
import {
  as,
  projectService as boardProjects,
  seedBoard,
  type Board,
} from "../../src/server/access/__tests__/board";
import {
  colSub,
  defineTaskService as defineCollectionTasks,
  labelService,
  receiveScopes,
} from "../../src/server/collections/__tests__/fixture";
import {
  defineTaskService,
  projectService,
  receive,
  recordingStorage,
  sub,
  type Read,
} from "../../src/server/emit/__tests__/live";
import { z } from "zod";
import { defineContract } from "../../src/contract/defineContract";
import {
  initQuickdraw,
  setupRedisAdapter,
  type Principal,
  type StorageAdapter,
} from "../../src/server/index";
import {
  defineLiveService,
  LOBBY,
  received,
  send,
  settle,
} from "../../src/server/realtime/__tests__/fixture";
import {
  createTestApp,
  emitWithAck,
  type TestApp,
  type TestConnection,
} from "../../src/testing/index";
import type * as Testing from "../../src/testing/createTestApp";
import {
  createBarrier,
  nodesOf,
  startNode,
  stopNodes,
  type ClusterNode,
  type CreateTestApp,
} from "./nodes";
import { closeClient, uniquePrefix, VALKEY_URL, valkeyClient } from "./valkey";

let h: Harness;
let board: Board;
const apps: TestApp[] = [];
const running: ClusterNode[][] = [];

beforeAll(async () => {
  h = await createHarness();
}, 60_000);

afterAll(async () => {
  await h.close();
});

beforeEach(async () => {
  await h.database.reset();
  board = await seedBoard(h.prisma);
});

afterEach(async () => {
  await Promise.all(apps.splice(0).map(async (app) => await app.close()));
  await Promise.all(running.splice(0).map(stopNodes));
});

/** A test app as two nodes: `createTestApp` boots both in the cluster projects. */
async function start(storage?: StorageAdapter) {
  const app = await createTestApp({
    services: [projectService, labelService, defineCollectionTasks()],
    db: h.db,
    ...(storage === undefined ? {} : { storage }),
  });
  apps.push(app as unknown as TestApp);
  return app;
}

type App = Awaited<ReturnType<typeof start>>;

/** A socket on node B, the writer node, with the entity frames it receives. */
async function connectToWriter(app: App, principal: Principal) {
  const [, writer] = nodesOf(app);
  const connection = await writer.app.connect(principal);
  return { connection, frames: receive(connection) };
}

async function connectToReader(app: App, principal: Principal) {
  const connection = await app.connect(principal);
  return { connection, frames: receive(connection) };
}

type Rename = { rename(input: { id: string; title: string }): Promise<unknown> };

function tasks(
  app: Pick<TestApp, "as">,
  principal: Principal,
): Rename & {
  setStatus(input: { id: string; status: string }): Promise<unknown>;
} {
  return (app.as(principal) as unknown as { readonly taskService: never }).taskService;
}

describe("revisions across nodes", () => {
  it("gives a write on node B a revision above every frame node A sent before", async () => {
    const app = await start();
    const reader = await connectToReader(app, as(board.cy));
    await sub(reader.connection, "taskService", [board.t1]);
    const [nodeA] = nodesOf(app);
    // A write on node A, then one on node B: the subscriber on node A gets both.
    await nodeA.app.server.dispatcher.run(() =>
      h.db.task.update({ where: { id: board.t1 }, data: { title: "On A" } }),
    );
    await app.server.dispatcher.run(() =>
      h.db.task.update({ where: { id: board.t1 }, data: { title: "On B" } }),
    );
    await reader.frames.settle();
    const revs = reader.frames.entity.map((frame) => frame.rev);
    const titles = reader.frames.entity.map(
      (frame) => (frame as { d?: { title?: string } }).d?.title,
    );
    expect(titles).toEqual(["On A", "On B"]);
    expect(revs[1]).toBeGreaterThan(revs[0] ?? Number.POSITIVE_INFINITY);
  });

  it("answers a re-subscribe on a quiet node no older than the newer frames the client holds", async () => {
    const app = await start();
    // Node A never flushes: every write goes through node B.
    const first = await connectToReader(app, as(board.cy));
    await sub(first.connection, "taskService", [board.t1]);
    await app.server.dispatcher.run(() =>
      h.db.task.update({ where: { id: board.t1 }, data: { title: "Seen" } }),
    );
    await first.frames.settle();
    const held = first.frames.entity.at(-1) as { d?: unknown; rev: number } | undefined;
    expect(held?.d).toMatchObject({ title: "Seen" });
    first.connection.close();
    await app.server.dispatcher.run(() =>
      h.db.task.update({ where: { id: board.t1 }, data: { title: "Missed" } }),
    );
    // The client comes back to node A holding the row at the revision of the frame it saw.
    const again = await connectToReader(app, as(board.cy));
    const reply = (await sub(again.connection, "taskService", [board.t1], [held?.rev ?? 0])) as {
      readonly r: readonly [{ readonly d: { readonly title: string }; readonly rev: number }];
    };
    expect(reply.r[0].d.title).toBe("Missed");
    expect(reply.r[0].rev).toBeGreaterThan(held?.rev ?? Number.POSITIVE_INFINITY);
    // As the client applies it: the reply replaces the row it held, since it is not older.
    const entry: EntityEntry<unknown> = {
      data: held?.d,
      rev: held?.rev,
      removed: false,
      error: null,
      readAt: undefined,
    };
    const result = reply.r[0] as unknown as EntityResult;
    expect(applyEntityResult(entry, result, undefined).entry.data).toMatchObject({
      title: "Missed",
    });
  });
});

/** A storage adapter whose next entity-frame read of a task row waits for `release`. */
function holdingFrameReads(storage: StorageAdapter) {
  let armed = false;
  const reached = deferred();
  const released = deferred();
  const isFrameRead = (read: Read): boolean =>
    read.model === "task" &&
    typeof read.args.select === "object" &&
    read.args.select !== null &&
    "updatedAt" in read.args.select;
  const recorded = recordingStorage(storage, undefined, (read) => {
    if (!armed || !isFrameRead(read)) {
      return undefined;
    }
    armed = false;
    reached.resolve();
    return released.promise;
  });
  return {
    storage: recorded.storage,
    arm: () => {
      armed = true;
    },
    reached: reached.promise,
    release: () => {
      released.resolve();
    },
  };
}

describe("two writes to one row on two nodes", () => {
  it("leave every subscriber with both, though the first node's frames arrive last", async () => {
    // Node A reads its frames' rows through a storage that can hold the read.
    const create = (await vi.importActual<typeof Testing>("../../src/testing/createTestApp"))
      .createTestApp as CreateTestApp;
    const prefix = uniquePrefix("order");
    const holding = holdingFrameReads(h.storage);
    const services = [projectService, defineTaskService()];
    const a = await startNode(create, { services, db: h.db, storage: holding.storage }, { prefix });
    const b = await startNode(create, { services, db: h.db }, { prefix });
    running.push([a, b]);
    const watcher = await b.app.connect(as(board.cy));
    const frames: EntityFrame[] = [];
    watcher.socket.on("qd:e", (frame: EntityFrame) => frames.push(frame));
    await sub(watcher, "taskService", [board.t1]);

    // Node A writes first, and its flush is held before it reads the row for its frames.
    holding.arm();
    const first = tasks(a.app, as(board.ada)).rename({ id: board.t1, title: "From A" });
    await holding.reached;
    // Node B writes next: its revision is greater, and its frames go out at once.
    await tasks(b.app, as(board.ada)).setStatus({ id: board.t1, status: "done" });
    holding.release();
    await first;
    await createBarrier(a.app.server.io, b.app.server.io)();
    await receive({ socket: watcher.socket }).settle();

    expect(frames).toHaveLength(2);
    const [fromB, fromA] = frames;
    expect(fromA?.rev).toBeLessThan(fromB?.rev ?? 0);
    // Applied by revision as the client does: node A's older frame is dropped, and node B's
    // (read after node A's write) carries both changes, because it went out whole.
    let entry: EntityEntry<unknown> | undefined;
    for (const frame of frames) {
      entry = applyEntityFrame(entry, frame).entry;
    }
    expect(entry?.data).toMatchObject({ title: "From A", status: "done" });
  });
});

describe("the other node", () => {
  it("answers a resume there with a page: its buffer saw none of the flushes", async () => {
    const app = await start();
    const reader = await app.connect(as(board.ada));
    const first = await colSub(reader, "byProject", board.p1);
    await app.server.dispatcher.run(() =>
      h.db.task.update({ where: { id: board.t1 }, data: { title: "Moved on" } }),
    );
    const elsewhere = await connectToWriter(app, as(board.ada));
    const resumed = await colSub(elsewhere.connection, "byProject", board.p1, {
      since: first.rev as number,
    });
    expect(resumed).toMatchObject({ ok: true, items: [{ id: board.t1, title: "Moved on" }] });
    expect(resumed).not.toHaveProperty("resumed");
  });

  it("disconnects a user's sockets on every node: logout everywhere", async () => {
    const app = await start();
    const onA = await app.connect(as(board.bo));
    const onB = (await connectToWriter(app, as(board.bo))).connection;
    const other = await app.connect(as(board.cy));
    const closed = (connection: Pick<TestConnection, "socket">) =>
      new Promise<string>((resolve) => {
        connection.socket.once("disconnect", resolve);
      });
    const gone = Promise.all([closed(onA), closed(onB)]);
    // Node B ends its own socket, and tells node A to end its one.
    expect(app.server.access.disconnectUser(board.bo, { reason: "logout everywhere" })).toBe(1);
    expect(await gone).toEqual(["io server disconnect", "io server disconnect"]);
    expect(other.socket.connected).toBe(true);
  });

  it("removes a row touched as removed from the scopes subscribed on both nodes", async () => {
    const app = await start();
    const onA = await app.connect(as(board.ada));
    const onB = (await connectToWriter(app, as(board.ada))).connection;
    const scopesA = receiveScopes(onA);
    const scopesB = receiveScopes(onB);
    await colSub(onA, "byProject", board.p1);
    await colSub(onB, "byProject", board.p1);
    await colSub(onA, "board", board.p1);
    // The write names no scope: the row's old scope went with it (a raw delete, reported
    // with `ctx.touch` and `removed`).
    await h.prisma.task.delete({ where: { id: board.t1 } });
    await app.server.dispatcher.run((ctx) => {
      ctx.touch("task", [board.t1], { removed: true });
    });
    await Promise.all([scopesA.settle(), scopesB.settle()]);
    const removals = (scopes: ReturnType<typeof receiveScopes>, c: string) =>
      scopes.frames
        .filter((frame) => frame.c === c)
        .flatMap((frame) => frame.deltas)
        .filter((delta) => delta.t === "removed" && delta.id === board.t1);
    // Each subscribed scope hears of it; one subscribed on both nodes may hear twice.
    expect(removals(scopesB, "byProject").length).toBeGreaterThanOrEqual(1);
    expect(removals(scopesA, "byProject").length).toBeGreaterThanOrEqual(1);
    expect(removals(scopesA, "board")).toHaveLength(1);
  });

  it("keeps a row touched as removed in the scope it is in at the read, on both nodes", async () => {
    const app = await start();
    const onA = await app.connect(as(board.ada));
    const onB = (await connectToWriter(app, as(board.ada))).connection;
    const scopesA = receiveScopes(onA);
    const scopesB = receiveScopes(onB);
    await colSub(onA, "byProject", board.p1);
    await colSub(onB, "byProject", board.p1);
    await colSub(onA, "board", board.p1);
    // The row is there when node B reads it (its id created again by a write whose flush went
    // first): it stays in P1 for every subscriber, and node A removes it from no scope.
    await app.server.dispatcher.run((ctx) => {
      ctx.touch("task", [board.t1], { removed: true });
    });
    await Promise.all([scopesA.settle(), scopesB.settle()]);
    const deltas = (scopes: ReturnType<typeof receiveScopes>, c: string) =>
      scopes.frames.filter((frame) => frame.c === c).flatMap((frame) => frame.deltas);
    for (const scopes of [scopesA, scopesB]) {
      expect(deltas(scopes, "byProject")).toEqual([
        { t: "added", item: expect.objectContaining({ id: board.t1, title: "T1" }) },
      ]);
    }
    expect(deltas(scopesA, "board")).toEqual([]);
  });
});

describe("a channel's app room across nodes", () => {
  it("is checked on the node the sending socket is on: a join there counts for that socket only", async () => {
    const into = received();
    const app = await createTestApp({
      services: [boardProjects, defineLiveService(into)],
      db: h.db,
    });
    apps.push(app as unknown as TestApp);
    const nodeB = nodesOf(app)[1].app as unknown as typeof app;
    // One player with a socket on each node: the one on node B joins the lobby.
    const onA = await app.connect(as(board.cy));
    const onB = await nodeB.connect(as(board.cy));
    expect(await onB.call.taskService.enter({ room: LOBBY })).toBe(true);
    send(onA, "shout", { n: 1 });
    send(onB, "shout", { n: 2 });
    await Promise.all([settle(onA), settle(onB)]);
    expect(into.shout).toEqual([{ userId: board.cy, socketId: onB.socket.id, n: 2 }]);
    // Presence answers for the whole cluster; the channel asks the sending socket only.
    expect(await app.server.presence.users(LOBBY)).toEqual([board.cy]);
  });
});

describe("closing one node", () => {
  it("tells the other nodes' rooms its users left, and takes milliseconds", async () => {
    const app = await createTestApp({
      services: [boardProjects, defineLiveService(received())],
      db: h.db,
    });
    apps.push(app as unknown as TestApp);
    const [nodeA, nodeB] = nodesOf(app) as unknown as readonly [
      { app: typeof app },
      { app: typeof app },
    ];
    const onA = await nodeA.app.connect(as(board.cy));
    const onB = await nodeB.app.connect(as(board.ada));
    const heard: PresenceFrame[] = [];
    onB.socket.on("qd:presence", (frame: PresenceFrame) => heard.push(frame));
    expect(await onA.call.taskService.enter({ room: LOBBY })).toBe(true);
    expect(await onB.call.taskService.enter({ room: LOBBY })).toBe(true);
    // Node B's member sees node A's in the room: the presence list read from both nodes.
    await vi.waitFor(() => {
      expect(heard.some(({ users }) => users?.includes(board.cy) === true)).toBe(true);
    });
    heard.length = 0;
    const gone = new Promise<string>((resolve) => {
      onA.socket.once("disconnect", resolve);
    });
    const started = performance.now();
    // Node A's sockets leave while its adapter still reaches node B; it used to wait out the
    // adapter's 5 s requestsTimeout, and node B never heard `left`. (The server's own close: the
    // test app's would disconnect its clients first.)
    await nodeA.app.server.close();
    const closedIn = performance.now() - started;
    await vi.waitFor(() => {
      expect(heard).toContainEqual({ room: LOBBY, left: board.cy });
    }, 5000);
    expect(closedIn).toBeLessThan(1000);
    // Its connection closed, not ended by the server: the client reconnects (to another node).
    expect(await gone).toBe("transport close");
  });
});

describe("a via scope on the other node", () => {
  it("resets when junction rows go without values: no node can name the scopes they left", async () => {
    const app = await start();
    const bug = await h.prisma.label.create({ data: { projectId: board.p1, name: "Bug" } });
    const link = await h.prisma.taskLabel.create({ data: { taskId: board.t1, labelId: bug.id } });
    const reader = await app.connect(as(board.ada));
    const scopes = receiveScopes(reader);
    await colSub(reader, "byLabel", bug.id);
    // A raw SQL delete the app reports with ctx.touch: the junction row's values are gone.
    await app.server.dispatcher.run((ctx) => {
      ctx.touch("taskLabel", [link.id], { removed: true });
    });
    await scopes.settle();
    expect(scopes.frames).toEqual([
      expect.objectContaining({ c: "byLabel", scope: bug.id, deltas: [{ t: "reset" }] }),
    ]);
  });
});

describe("a stream's seed on a node that started after the pushes", () => {
  it("is empty where the stream keeps the latest items, and the current state where the service computes it", async () => {
    const create = (await vi.importActual<typeof Testing>("../../src/testing/createTestApp"))
      .createTestApp as CreateTestApp;
    const prefix = uniquePrefix("seeds");
    const feed = defineContract("feedService", {
      streams: {
        kept: { item: z.number(), seed: 3, access: "public" },
        computed: { item: z.number(), scope: "roomId", access: "public" },
      },
    });
    // The app's own state, which each computed item changes: a counter per room.
    const counters = new Map<string, number>();
    const service = initQuickdraw<{ principal: Principal }>().defineService(feed, {
      methods: {},
      streams: { computed: { seed: (roomId) => [counters.get(roomId) ?? 0] } },
    });
    const early = await startNode(create, { services: [service] }, { prefix });
    running.push([early]);
    for (const n of [1, 2, 3]) {
      counters.set("r1", n);
      early.app.server.stream(feed, "kept").push(n);
      early.app.server.stream(feed, "computed").push("r1", n);
    }
    const late = await startNode(create, { services: [service] }, { prefix });
    running.push([late]);
    const onLate = await late.app.connect(null);
    const ask = (stream: string, scope?: string) =>
      emitWithAck(onLate.socket, "qd:stream:sub", { s: "feedService", stream, scope });
    // The kept seed is per node: the late node saw none of the pushes.
    expect(await ask("kept")).toEqual({ ok: true, seed: [] });
    expect(await ask("computed", "r1")).toEqual({ ok: true, seed: [3] });
    // And it hears what the early node pushes from now on.
    const items: unknown[] = [];
    onLate.socket.on("qd:stream", (frame: unknown) => items.push(frame));
    counters.set("r1", 4);
    early.app.server.stream(feed, "computed").push("r1", 4);
    await vi.waitFor(() => {
      expect(items).toHaveLength(1);
    });
  });
});

describe("setupRedisAdapter", () => {
  it("wires the shared counter too: the documented way to run several nodes", async () => {
    const create = (await vi.importActual<typeof Testing>("../../src/testing/createTestApp"))
      .createTestApp as CreateTestApp;
    const prefix = uniquePrefix("setup");
    const { hostname, port } = new URL(VALKEY_URL);
    const boot = async () => {
      const app = await create({
        services: [projectService, defineTaskService()],
        db: h.db,
        cluster: { keyPrefix: prefix },
      });
      const redis = await setupRedisAdapter(app.server.io, {
        host: hostname,
        port: Number(port),
        keyPrefix: prefix,
      });
      expect(redis.success).toBe(true);
      return { app: app as unknown as TestApp, redis };
    };
    const a = await boot();
    const b = await boot();
    try {
      const reader = await a.app.connect(as(board.cy));
      const frames = receive(reader);
      await sub(reader, "taskService", [board.t1]);
      await tasks(b.app, as(board.ada)).rename({ id: board.t1, title: "Through the helper" });
      await createBarrier(b.app.server.io, a.app.server.io)();
      await frames.settle();
      const [frame] = frames.entity;
      expect(frame).toMatchObject({ t: "u", d: { title: "Through the helper" } });
      const client = valkeyClient();
      await client.connect();
      const counter = Number(await client.get(`${prefix}:rev`));
      await closeClient(client);
      expect(frame?.rev).toBe(counter);
    } finally {
      await Promise.all([a.app.close(), b.app.close()]);
      await Promise.all([a.redis.cleanup(), b.redis.cleanup()]);
    }
  });
});
