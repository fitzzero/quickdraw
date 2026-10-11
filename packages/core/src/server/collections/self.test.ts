// Self scopes follow the item service's row policy (the 5.1 audit's COLL-1).
// A `scopeAccess: "self"` scope is its user's to open, but its items were
// every row whose scope column (or junction) named that user, whatever the
// item service's policy said: a task still assigned to a user removed from
// its project kept reaching them, title and all. Its pages, `qd:col:items`
// and frames now hold only the rows the policy lets its user read.
//
//            owner   access list    members
//   P1       ada     di: Read       bo: Moderate, cy: Read
//   P2       ed      -              -
//   T1 in P1, T2 in P2

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { z } from "zod";
import { inCluster } from "../../../test/cluster/mode";
import type { PrismaClient } from "../../../test/prisma/setup";
import { defineContract, via, type CollectionFrame } from "../../index";
import { createHarness, type Harness } from "../../prisma/__tests__/harness";
import { createTestApp, emitWithAck, type TestApp } from "../../testing/index";
import { as, projectMembers, seedBoard, type Board } from "../access/__tests__/board";
import { projectService, qd } from "../emit/__tests__/live";
import { anyOf, jsonAcl, type AnyService, type Principal, type ServiceGrants } from "../index";
import { peeredCluster } from "../transports/__tests__/harness";
import {
  colItems,
  colSub,
  colUnsub,
  defineTaskService,
  labelService,
  receiveScopes,
} from "./__tests__/fixture";

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

interface StartOptions {
  readonly services?: readonly AnyService[];
  readonly socket?: Parameters<typeof createTestApp>[0]["socket"];
  readonly loadServiceAccess?: (userId: string) => ServiceGrants;
}

async function start(options: StartOptions = {}) {
  const fixture = [projectService, labelService, defineTaskService()] as const;
  const app = await createTestApp({
    services: [...fixture, ...(options.services ?? [])] as unknown as typeof fixture,
    db: h.db,
    ...(options.socket === undefined ? {} : { socket: options.socket }),
    ...(options.loadServiceAccess === undefined
      ? {}
      : { auth: { loadServiceAccess: options.loadServiceAccess } }),
  });
  apps.push(app as unknown as TestApp);
  return app;
}

type App = Awaited<ReturnType<typeof start>>;

async function connect(app: App, principal: Principal) {
  const connection = await app.connect(principal);
  return { connection, scopes: receiveScopes(connection) };
}

/** Runs `fn` in a unit of work of the app's dispatcher: its tracked writes flush to the sinks. */
function write<T>(app: App, fn: (db: PrismaClient) => Promise<T>): Promise<T> {
  return app.server.dispatcher.run(async () => await fn(h.db));
}

/** The deltas of the frames `frames` holds for collection `c` of service `s`. */
function deltasOf(frames: readonly CollectionFrame[], c: string, s = "taskService") {
  return frames.filter((frame) => frame.s === s && frame.c === c).flatMap((frame) => frame.deltas);
}

describe("a self scope on a service with a policy", () => {
  it("keeps a removed member's own list to the rows the policy lets them read (COLL-1)", async () => {
    const app = await start();
    await h.prisma.task.update({ where: { id: board.t1 }, data: { assigneeId: board.cy } });
    const cy = await connect(app, as(board.cy));
    expect(await colSub(cy.connection, "mine", board.cy)).toMatchObject({
      ok: true,
      items: [{ id: board.t1 }],
    });
    await write(app, (db) =>
      db.projectMember.deleteMany({ where: { projectId: board.p1, userId: board.cy } }),
    );
    await cy.scopes.settle();
    // The parent membership changed: the list loads again.
    expect(
      cy.scopes.frames.filter((frame) => frame.c === "mine").map((frame) => frame.deltas),
    ).toEqual([[{ t: "reset" }]]);
    expect(await colSub(cy.connection, "mine", board.cy)).toMatchObject({
      ok: true,
      items: [],
      total: 0,
    });
    expect(await colItems(cy.connection, "mine", board.cy, [board.t1])).toMatchObject({
      ok: true,
      items: [],
    });
    cy.scopes.clear();
    await write(app, (db) =>
      db.task.update({ where: { id: board.t1 }, data: { title: "Confidential rename" } }),
    );
    await cy.scopes.settle();
    expect(cy.scopes.frames.flatMap((frame) => frame.deltas)).toEqual([
      { t: "removed", id: board.t1 },
    ]);
    expect(JSON.stringify(cy.scopes.frames)).not.toContain("Confidential rename");
    const again = await connect(app, as(board.cy));
    expect(await colSub(again.connection, "mine", board.cy)).toMatchObject({
      ok: true,
      items: [],
    });
  });

  it("a member demoted below Read loses the row from their own via list", async () => {
    const myProjectContract = defineContract("myProjectService", {
      entity: z.object({ id: z.string(), name: z.string() }),
      methods: {},
      collections: {
        mine: {
          scope: via({ model: "projectMember", entry: "projectId", scope: "userId" }),
          item: "entity",
          order: [["id", "asc"]],
        },
      },
    });
    const myProjectService = qd.defineService(myProjectContract, {
      model: "project",
      access: anyOf(jsonAcl("acl", { owner: "ownerId" }), projectMembers),
      collections: { mine: { scopeAccess: "self" } },
      methods: {},
    });
    const app = await start({ services: [myProjectService] });
    const cy = await connect(app, as(board.cy));
    const subscribe = () =>
      emitWithAck(cy.connection.socket, "qd:col:sub", {
        s: "myProjectService",
        c: "mine",
        scope: board.cy,
      });
    expect(await subscribe()).toMatchObject({ ok: true, items: [{ id: board.p1 }] });
    await write(app, (db) =>
      db.projectMember.updateMany({
        where: { projectId: board.p1, userId: board.cy },
        data: { role: "Public" },
      }),
    );
    await cy.scopes.settle();
    const lost = deltasOf(cy.scopes.frames, "mine", "myProjectService");
    expect(lost.length).toBeGreaterThan(0);
    expect(lost.filter((delta) => !(delta.t === "removed" && delta.id === board.p1))).toEqual([]);
    cy.scopes.clear();
    await write(app, (db) =>
      db.project.update({ where: { id: board.p1 }, data: { name: "Secret plans" } }),
    );
    await cy.scopes.settle();
    expect(
      deltasOf(cy.scopes.frames, "mine", "myProjectService").filter(
        (delta) => delta.t !== "removed",
      ),
    ).toEqual([]);
    expect(JSON.stringify(cy.scopes.frames)).not.toContain("Secret plans");
    expect(await subscribe()).toMatchObject({ ok: true, items: [] });
  });
});

describe("access changes and a self scope", () => {
  /** The frames of `mine` the connection received, as their deltas. */
  const mineFrames = (scopes: { readonly frames: readonly CollectionFrame[] }) =>
    scopes.frames.filter((frame) => frame.c === "mine").map((frame) => frame.deltas);

  it("makes a resume read a page after a change nobody here received", async () => {
    const app = await start();
    await h.prisma.task.update({ where: { id: board.t1 }, data: { assigneeId: board.cy } });
    const cy = await connect(app, as(board.cy));
    const first = await colSub(cy.connection, "mine", board.cy);
    expect(first).toMatchObject({ ok: true, items: [{ id: board.t1 }] });
    await colUnsub(cy.connection, "mine", board.cy);
    await app
      .as(as(board.ada))
      .projectService.removeMember({ projectId: board.p1, userId: board.cy });
    const resumed = await colSub(cy.connection, "mine", board.cy, { since: first.rev as number });
    expect(resumed).not.toHaveProperty("resumed");
    expect(resumed).toMatchObject({ ok: true, items: [], total: 0 });
  });

  it("resets a self list when its user's grants are loaded again", async () => {
    const app = await start({ loadServiceAccess: () => ({}) });
    const cy = await connect(app, as(board.cy));
    await colSub(cy.connection, "mine", board.cy);
    await app.server.access.refresh(board.cy);
    await cy.scopes.settle();
    expect(mineFrames(cy.scopes)).toEqual([[{ t: "reset" }]]);
  });

  it("resets every self list of the service on a membership write without values", async () => {
    const app = await start();
    const bo = await connect(app, as(board.bo));
    const cy = await connect(app, as(board.cy));
    await colSub(bo.connection, "mine", board.bo);
    await colSub(cy.connection, "mine", board.cy);
    const membership = await h.prisma.projectMember.findFirstOrThrow({
      where: { userId: board.cy },
    });
    await app.server.dispatcher.run(() => {
      h.storage.unitOfWork.touch?.("projectMember", [membership.id]);
    });
    await bo.scopes.settle();
    await cy.scopes.settle();
    expect(mineFrames(bo.scopes)).toEqual([[{ t: "reset" }]]);
    expect(mineFrames(cy.scopes)).toEqual([[{ t: "reset" }]]);
  });

  it("removes a row of a column scope its user's membership of the row no longer reaches", async () => {
    // Projects by owner, readable by members only: ada owns P1 and joins it as a reader.
    const ownedContract = defineContract("ownedService", {
      entity: z.object({ id: z.string(), name: z.string(), ownerId: z.string() }),
      methods: {},
      collections: { mine: { scope: "ownerId", item: "entity", order: [["id", "asc"]] } },
    });
    const ownedService = qd.defineService(ownedContract, {
      model: "project",
      access: projectMembers,
      collections: { mine: { scopeAccess: "self" } },
      methods: {},
    });
    await h.prisma.projectMember.create({
      data: { projectId: board.p1, userId: board.ada, role: "Read" },
    });
    const app = await start({ services: [ownedService] });
    const ada = await connect(app, as(board.ada));
    expect(
      await emitWithAck(ada.connection.socket, "qd:col:sub", {
        s: "ownedService",
        c: "mine",
        scope: board.ada,
      }),
    ).toMatchObject({ ok: true, items: [{ id: board.p1 }] });
    await write(app, (db) =>
      db.projectMember.deleteMany({ where: { projectId: board.p1, userId: board.ada } }),
    );
    await ada.scopes.settle();
    expect(deltasOf(ada.scopes.frames, "mine", "ownedService")).toEqual([
      { t: "removed", id: board.p1 },
    ]);
  });

  it("decides a service-wide Admin's view of another user's list for that user", async () => {
    const app = await start();
    await h.prisma.task.update({ where: { id: board.t1 }, data: { assigneeId: board.cy } });
    await h.prisma.projectMember.deleteMany({ where: { projectId: board.p1, userId: board.cy } });
    const admin = await connect(app, as(board.ed, { taskService: "Admin" }));
    // The Admin reads the page whole; frames follow the owner's level.
    expect(await colSub(admin.connection, "mine", board.cy)).toMatchObject({
      ok: true,
      items: [{ id: board.t1 }],
    });
    await write(app, (db) =>
      db.task.update({ where: { id: board.t1 }, data: { title: "Confidential rename" } }),
    );
    await admin.scopes.settle();
    expect(deltasOf(admin.scopes.frames, "mine")).toEqual([{ t: "removed", id: board.t1 }]);
    expect(JSON.stringify(admin.scopes.frames)).not.toContain("Confidential rename");
  });

  it("removes a row for every socket of a user one of whose principals may not read it", async () => {
    const app = await start();
    await h.prisma.task.update({ where: { id: board.t1 }, data: { assigneeId: board.cy } });
    await h.prisma.projectMember.deleteMany({ where: { projectId: board.p1, userId: board.cy } });
    const granted = await connect(app, as(board.cy, { taskService: "Admin" }));
    const plain = await connect(app, as(board.cy));
    await colSub(granted.connection, "mine", board.cy);
    await colSub(plain.connection, "mine", board.cy);
    await write(app, (db) =>
      db.task.update({ where: { id: board.t1 }, data: { title: "Confidential rename" } }),
    );
    await granted.scopes.settle();
    await plain.scopes.settle();
    expect(deltasOf(plain.scopes.frames, "mine")).toEqual([{ t: "removed", id: board.t1 }]);
    expect(deltasOf(granted.scopes.frames, "mine")).toEqual([{ t: "removed", id: board.t1 }]);
  });
});

describe.skipIf(inCluster())("a self scope behind a cluster adapter", () => {
  it("never sends a row the user may not read back whole", async () => {
    const cluster = peeredCluster();
    const app = await start({ socket: { adapter: cluster.adapter } });
    cluster.servers.push(app.server.io);
    await h.prisma.task.update({ where: { id: board.t1 }, data: { assigneeId: board.cy } });
    await h.prisma.projectMember.deleteMany({ where: { projectId: board.p1, userId: board.cy } });
    const cy = await connect(app, as(board.cy));
    expect(await colSub(cy.connection, "mine", board.cy)).toMatchObject({ ok: true, items: [] });
    await write(app, (db) =>
      db.task.update({ where: { id: board.t1 }, data: { title: "Confidential rename" } }),
    );
    await cy.scopes.settle();
    const deltas = deltasOf(cy.scopes.frames, "mine");
    expect(deltas.length).toBeGreaterThan(0);
    expect(deltas.filter((delta) => delta.t !== "removed")).toEqual([]);
    expect(JSON.stringify(cy.scopes.frames)).not.toContain("Confidential rename");
  });
});
