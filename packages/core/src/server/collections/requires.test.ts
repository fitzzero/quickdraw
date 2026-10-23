// A collection that `requires: { service: L }` (RFC 0003 section 7.1): its
// subscribers need a service-wide grant of at least `L` on the collection's
// service, as a method's `{ service: L }` form counts it, besides the anchor
// or self check. Without it a scope is `FORBIDDEN`, whatever the anchor
// says; a service-wide `Admin` passes; and a reload of the user's grants
// below it takes their sockets out of the scope (`qd:revoked`), so the next
// write sends them nothing. Behind a cluster the reload runs on the writer
// node and revokes on the reader node, where the sockets are.
//
//            owner   access list    members
//   P1       ada     di: Read       bo: Moderate, cy: Read
//   P2       ed      -              -
//   T1 in P1, T2 in P2

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { z } from "zod";
import type { PrismaClient } from "../../../test/prisma/setup";
import { collectionRoom } from "../../contract/names";
import { defineContract, search as searchContract } from "../../index";
import { createHarness, type Harness } from "../../prisma/__tests__/harness";
import { createTestApp, emitWithAck, type TestApp } from "../../testing/index";
import { as, seedBoard, type Board } from "../access/__tests__/board";
import { projectContract, projectService, qd } from "../emit/__tests__/live";
import { inherit, search, type Principal, type ServiceGrants } from "../index";
import { receiveScopes } from "./__tests__/fixture";

const task = z.object({
  id: z.string(),
  projectId: z.string(),
  title: z.string(),
  assigneeId: z.string().nullable(),
});

const grantedContract = defineContract("grantedService", {
  entity: task,
  methods: {
    ...searchContract.contract({ entity: task, fields: ["title"], scope: "board" }),
  },
  collections: {
    /** The tasks assigned to the subscriber: theirs, for holders of the service's Read grant. */
    mine: { scope: "assigneeId", item: "entity", order: [["id", "asc"]] },
    /** A project's tasks: Read on the project, and the service's Moderate grant. */
    board: { scope: "projectId", item: "entity", order: [["id", "asc"]] },
    /** The same, with no grant required. */
    open: { scope: "projectId", item: "entity", order: [["id", "asc"]] },
  },
});

const grantedService = qd.defineService(grantedContract, {
  model: "task",
  access: inherit({ from: projectContract, via: "projectId" }),
  collections: {
    mine: { scopeAccess: "self", requires: { service: "Read" } },
    board: { anchor: projectContract, requires: { service: "Moderate" } },
    open: { anchor: projectContract },
  },
  methods: { ...search.handlers(grantedContract, { access: "authenticated" }) },
});

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
  await h.prisma.task.updateMany({ data: { assigneeId: board.cy } });
});

afterEach(async () => {
  await Promise.all(apps.splice(0).map(async (app) => await app.close()));
});

async function start(loadServiceAccess?: (userId: string) => ServiceGrants) {
  const app = await createTestApp({
    services: [projectService, grantedService],
    db: h.db,
    ...(loadServiceAccess === undefined ? {} : { auth: { loadServiceAccess } }),
  });
  apps.push(app as unknown as TestApp);
  return app;
}

type App = Awaited<ReturnType<typeof start>>;

async function connect(app: App, principal: Principal) {
  const connection = await app.connect(principal);
  const subscribe = (c: string, scope: string) =>
    emitWithAck(connection.socket, "qd:col:sub", { s: "grantedService", c, scope });
  return { connection, subscribe, scopes: receiveScopes(connection) };
}

/** Runs `fn` in a unit of work of the app's dispatcher: its tracked writes flush to the sinks. */
function write<T>(app: App, fn: (db: PrismaClient) => Promise<T>): Promise<T> {
  return app.server.dispatcher.run(async () => await fn(h.db));
}

/** The sockets in a scope's room on the node clients connect to. */
function inRoom(app: App, collection: string, scope: string): number {
  const room = collectionRoom("grantedService", collection, scope);
  return app.server.io.sockets.adapter.rooms.get(room)?.size ?? 0;
}

const forbidden = { ok: false, e: { code: "FORBIDDEN", message: "Insufficient permissions" } };

describe("a self list that requires a service grant", () => {
  it("is refused without the grant, below it and with another service's, and served with it", async () => {
    const app = await start();
    for (const grants of [undefined, { grantedService: "Public" }, { projectService: "Admin" }]) {
      const cy = await connect(app, as(board.cy, grants as ServiceGrants | undefined));
      expect({ grants, answer: await cy.subscribe("mine", board.cy) }).toEqual({
        grants,
        answer: forbidden,
      });
    }
    expect(inRoom(app, "mine", board.cy)).toBe(0);
    const reader = await connect(app, as(board.cy, { grantedService: "Read" }));
    // The grant adds to the self check: her own list, with the rows the policy lets her read.
    expect(await reader.subscribe("mine", board.cy)).toMatchObject({
      ok: true,
      items: [{ id: board.t1 }],
    });
    expect(await reader.subscribe("mine", board.bo)).toEqual(forbidden);
  });

  it("lets a service-wide Admin through, whoever's list it is", async () => {
    const app = await start();
    const admin = await connect(app, as(board.ed, { grantedService: "Admin" }));
    expect(await admin.subscribe("mine", board.cy)).toMatchObject({ ok: true });
  });
});

describe("an anchored list that requires a service grant", () => {
  it("needs both the grant and the level on the anchor row", async () => {
    const app = await start();
    // bo moderates P1 as a member; a Read grant is below the board's Moderate.
    for (const grants of [undefined, { grantedService: "Read" }]) {
      const bo = await connect(app, as(board.bo, grants as ServiceGrants | undefined));
      expect(await bo.subscribe("board", board.p1)).toEqual(forbidden);
      // A collection without requires is unchanged.
      expect(await bo.subscribe("open", board.p1)).toMatchObject({ ok: true });
    }
    const moderator = await connect(app, as(board.bo, { grantedService: "Moderate" }));
    expect(await moderator.subscribe("board", board.p1)).toMatchObject({
      ok: true,
      items: [{ id: board.t1 }],
    });
    // The grant does not replace the anchor's check: ed has no level on P1.
    const stranger = await connect(app, as(board.ed, { grantedService: "Moderate" }));
    expect(await stranger.subscribe("board", board.p1)).toEqual(forbidden);
    const admin = await connect(app, as(board.ed, { grantedService: "Admin" }));
    expect(await admin.subscribe("board", board.p1)).toMatchObject({ ok: true });
    expect(inRoom(app, "board", board.p1)).toBe(2);
  });

  it("refuses its topic and a search kept to it on the same terms", async () => {
    const app = await start();
    const bo = await connect(app, as(board.bo, { grantedService: "Read" }));
    expect(
      await emitWithAck(bo.connection.socket, "qd:watch", {
        s: "grantedService",
        topic: `board:${board.p1}`,
      }),
    ).toMatchObject({ ok: false, e: { code: "FORBIDDEN" } });
    const searchAs = (grants: ServiceGrants) =>
      app.as(as(board.bo, grants)).grantedService.search({ q: "T1", scope: board.p1 });
    await expect(searchAs({ grantedService: "Read" })).rejects.toMatchObject({
      code: "FORBIDDEN",
    });
    expect(await searchAs({ grantedService: "Moderate" })).toMatchObject({
      items: [{ id: board.t1 }],
    });
  });
});

describe("a grant lost while subscribed", () => {
  it("takes the socket out of the self list and the anchored list, and says so", async () => {
    const grants = new Map<string, ServiceGrants>([
      [board.cy, { grantedService: "Moderate" }],
      [board.ada, { grantedService: "Moderate" }],
    ]);
    const app = await start((userId) => grants.get(userId) ?? {});
    const cy = await connect(app, as(board.cy));
    const ada = await connect(app, as(board.ada));
    expect(await cy.subscribe("mine", board.cy)).toMatchObject({ ok: true });
    expect(await cy.subscribe("board", board.p1)).toMatchObject({ ok: true });
    expect(await cy.subscribe("open", board.p1)).toMatchObject({ ok: true });
    expect(await ada.subscribe("board", board.p1)).toMatchObject({ ok: true });
    grants.set(board.cy, {});
    await app.server.access.refresh(board.cy);
    await cy.scopes.settle();
    const revoked = (c: string, scope: string) => ({
      kind: "collection",
      reason: "access",
      s: "grantedService",
      c,
      scope,
    });
    expect(cy.scopes.revoked).toEqual(
      expect.arrayContaining([revoked("mine", board.cy), revoked("board", board.p1)]),
    );
    expect(cy.scopes.revoked).toHaveLength(2);
    // Revoked, never reset: the socket left the rooms.
    expect(cy.scopes.frames.filter((frame) => frame.c === "mine")).toEqual([]);
    expect(inRoom(app, "mine", board.cy)).toBe(0);
    expect(inRoom(app, "board", board.p1)).toBe(1);
    cy.scopes.clear();
    await write(app, (db) => db.task.update({ where: { id: board.t1 }, data: { title: "After" } }));
    await Promise.all([cy.scopes.settle(), ada.scopes.settle()]);
    // Only the list without requires still reaches cy; ada keeps the board.
    expect(cy.scopes.frames.map(({ c, scope }) => ({ c, scope }))).toEqual([
      { c: "open", scope: board.p1 },
    ]);
    expect(ada.scopes.frames.map(({ c, scope }) => ({ c, scope }))).toEqual([
      { c: "board", scope: board.p1 },
    ]);
    // Subscribing again is refused, until the grant comes back.
    expect(await cy.subscribe("mine", board.cy)).toEqual(forbidden);
    grants.set(board.cy, { grantedService: "Read" });
    await app.server.access.refresh(board.cy);
    expect(await cy.subscribe("mine", board.cy)).toMatchObject({ ok: true });
    expect(await cy.subscribe("board", board.p1)).toEqual(forbidden);
  });
});
