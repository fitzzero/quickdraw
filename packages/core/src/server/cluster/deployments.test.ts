// Two deployments sharing one bus (the 5.1 audit's RT-2): production and
// staging on one Valkey, with different `cluster.keyPrefix`es, hear each
// other's server-to-server events, and before 5.1 applied them: staging's
// reloaded grants made a production user Admin, its disconnects, stream
// items, room removals and access changes acted on production's sockets.
// Here the bus is the in-process peered adapter (`peeredCluster`); a foreign
// event is answered, so staging never goes degraded, and not applied. An
// untagged event, from a node of an earlier version during a rolling deploy,
// is applied with one warning.

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createHarness, type Harness } from "../../prisma/__tests__/harness";
import { createTestApp, emitWithAck, type TestApp } from "../../testing/index";
import { captureLogger } from "../__tests__/fixtures";
import { as, projectService, seedBoard, type Board } from "../access/__tests__/board";
import type { ServiceGrants } from "../index";
import {
  defineLiveService,
  frames,
  liveContract,
  received,
  settle,
  streamSub,
} from "../realtime/__tests__/fixture";
import { UNNAMED_EVENT } from "../collections/unnamed";
import { peeredCluster } from "../transports/__tests__/harness";
import { GRANTS_EVENT } from "../transports/pushes";

let h: Harness;
let board: Board;
const apps: TestApp[] = [];

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
});

/** Production and staging on one bus, each with its own keyPrefix; staging grants every user Admin. */
async function deployments() {
  const bus = peeredCluster();
  const start = async (keyPrefix: string, grants: ServiceGrants) => {
    const logger = captureLogger();
    const app = await createTestApp({
      services: [projectService, defineLiveService(received())],
      db: h.db,
      socket: { adapter: bus.adapter },
      cluster: { keyPrefix },
      auth: { loadServiceAccess: () => grants },
      logger,
    });
    apps.push(app as unknown as TestApp);
    return { app, logger };
  };
  const prod = await start("prod", {});
  const staging = await start("staging", { taskService: "Admin" });
  bus.servers.push(prod.app.server.io, staging.app.server.io);
  return { prod, staging };
}

type Deployment = Awaited<ReturnType<typeof deployments>>["prod"];

/** The principal of `userId`'s sockets on `app`'s node. */
function grantsOn(deployment: Deployment, userId: string): unknown[] {
  return [...deployment.app.server.io.sockets.sockets.values()]
    .filter((socket) => socket.data.principal?.userId === userId)
    .map((socket) => socket.data.principal?.serviceAccess);
}

const messagesOf = (deployment: Deployment, level: "warn" | "error") =>
  deployment.logger.at(level).map((entry) => entry.message);

describe("two deployments on one bus (RT-2)", () => {
  it("need a cluster.keyPrefix that is a non-empty string", async () => {
    for (const keyPrefix of ["", null, 7]) {
      await expect(
        createTestApp({ services: [projectService], db: h.db, cluster: { keyPrefix } as never }),
      ).rejects.toThrow("createServer: cluster.keyPrefix must be a non-empty string");
    }
  });

  it("never apply each other's grants, and answer them so neither goes degraded", async () => {
    const { prod, staging } = await deployments();
    const cy = await prod.app.connect(as(board.cy));
    expect(grantsOn(prod, board.cy)).toEqual([{}]);
    await staging.app.server.access.refresh(board.cy);
    await settle(cy);
    expect(grantsOn(prod, board.cy)).toEqual([{}]);
    expect(await streamSub(cy, "adminFeed")).toMatchObject({
      ok: false,
      e: { code: "FORBIDDEN" },
    });
    expect(messagesOf(staging, "error").join("\n")).not.toContain("did not answer a broadcast");
    const errors = messagesOf(prod, "error");
    expect(errors).toHaveLength(1);
    expect(errors[0]).toContain('cluster.keyPrefix "staging"');
  });

  it("never act on each other's disconnects, stream items, room removals or access changes", async () => {
    const { prod, staging } = await deployments();
    const cy = await prod.app.connect(as(board.cy));
    const streams = frames(cy, "qd:stream");
    const revoked = frames(cy, "qd:revoked");
    expect(await streamSub(cy, "status")).toMatchObject({ ok: true });
    expect(await cy.call.taskService.enter({ room: "lobby" })).toBe(true);
    expect(
      await emitWithAck(cy.socket, "qd:sub", { s: "taskService", ids: [board.t1] }),
    ).toMatchObject({ ok: true, r: [{ ok: true }] });

    staging.app.server.access.disconnectUser(board.cy);
    // The bus hands the event over at once: a disconnect applied here would have ended cy's socket already.
    expect(prod.app.server.io.sockets.sockets.has(cy.socket.id ?? "")).toBe(true);
    staging.app.server.stream(liveContract, "status").push("from staging");
    await staging.app.server.rooms.leave("lobby", { userId: board.cy });
    // The test database is shared, which real deployments never share: the point is that
    // production does not act on staging's broadcast of the change.
    await staging.app.server.dispatcher.run(async () => {
      await h.db.projectMember.deleteMany({ where: { userId: board.cy, projectId: board.p1 } });
    });
    await settle(cy);

    expect(cy.socket.connected).toBe(true);
    expect(streams).toEqual([]);
    expect(prod.app.server.rooms.size("lobby")).toBe(1);
    expect(revoked).toEqual([]);
    const ada = await prod.app.connect(as(board.ada));
    expect(await streamSub(ada, "status")).toMatchObject({ ok: true, seed: [] });
  });

  it("never apply each other's unnamed collection removals", async () => {
    const { prod } = await deployments();
    const cy = await prod.app.connect(as(board.cy));
    const collection = frames(cy, "qd:c");
    expect(
      await emitWithAck(cy.socket, "qd:col:sub", {
        s: "taskService",
        c: "byProject",
        scope: board.p1,
      }),
    ).toMatchObject({ items: expect.any(Array) });
    const node = prod.app.server.io.sockets as unknown as {
      _onServerSideEmit(args: unknown[]): void;
    };
    // What a flush of each deployment broadcasts when it cannot place a removal.
    const removal = {
      s: "taskService",
      c: "byProject",
      rev: Date.now() * 1000,
      removed: [board.t1],
      reset: false,
    };
    node._onServerSideEmit([UNNAMED_EVENT, { ...removal, deployment: "staging" }]);
    await settle(cy);
    expect(collection).toEqual([]);
    node._onServerSideEmit([UNNAMED_EVENT, { ...removal, deployment: "prod" }]);
    await settle(cy);
    expect(collection).toEqual([
      expect.objectContaining({ deltas: [{ t: "removed", id: board.t1 }] }),
    ]);
    expect(messagesOf(prod, "error")).toEqual([
      expect.stringContaining('cluster.keyPrefix "staging"'),
    ]);
  });

  it("apply an event without a deployment, from a node of an earlier version, warning once", async () => {
    const { prod } = await deployments();
    const cy = await prod.app.connect(as(board.cy));
    const older = prod.app.server.io.sockets as unknown as {
      _onServerSideEmit(args: unknown[]): void;
    };
    older._onServerSideEmit([
      GRANTS_EVENT,
      { userId: board.cy, serviceAccess: { taskService: "Read" } },
      () => undefined,
    ]);
    await settle(cy);
    expect(grantsOn(prod, board.cy)).toEqual([{ taskService: "Read" }]);
    older._onServerSideEmit([
      GRANTS_EVENT,
      { userId: board.cy, serviceAccess: { taskService: "Moderate" } },
      () => undefined,
    ]);
    await settle(cy);
    expect(grantsOn(prod, board.cy)).toEqual([{ taskService: "Moderate" }]);
    expect(messagesOf(prod, "warn")).toEqual([
      expect.stringContaining(`A node sent ${GRANTS_EVENT} without its deployment`),
    ]);
  });
});
