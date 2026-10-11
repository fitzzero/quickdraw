// A `via` list over the item service's own `members` table counts only the
// links whose role gives at least the list's access (the 5.1 audit's
// COLL-1, its `via` variant): a member demoted to a role below `Read` kept
// the project in their list, with its updates. The list here is anchored on
// a directory of users, so only this rule decides, not the self scope's
// policy filter.
//
//            owner   access list    members
//   P1       ada     di: Read       bo: Moderate, cy: Read
//   P2       ed      -              -

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { z } from "zod";
import type { PrismaClient } from "../../../test/prisma/setup";
import { defineContract, via, type CollectionFrame } from "../../index";
import { createHarness, type Harness } from "../../prisma/__tests__/harness";
import { createTestApp, emitWithAck, type TestApp } from "../../testing/index";
import { as, projectMembers, seedBoard, type Board } from "../access/__tests__/board";
import { qd } from "../emit/__tests__/live";
import { anyOf, everyone, jsonAcl } from "../index";
import { receiveScopes } from "./__tests__/fixture";

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

/** Every user, readable by everyone: what the lists are anchored on. */
const directory = defineContract("directoryService", {
  entity: z.object({ id: z.string(), name: z.string() }),
  methods: {},
});

const directoryService = qd.defineService(directory, {
  model: "user",
  access: everyone("Read"),
  methods: {},
});

/** Each user's projects, through the very membership table the projects' policy reads. */
const projectsOf = defineContract("projectsOfService", {
  entity: z.object({ id: z.string(), name: z.string() }),
  methods: {},
  collections: {
    of: {
      scope: via({ model: "projectMember", entry: "projectId", scope: "userId" }),
      item: "entity",
      order: [["id", "asc"]],
    },
  },
});

const projectsOfService = qd.defineService(projectsOf, {
  model: "project",
  access: anyOf(jsonAcl("acl", { owner: "ownerId" }), projectMembers),
  collections: { of: { anchor: directory } },
  methods: {},
});

async function start() {
  const app = await createTestApp({ services: [directoryService, projectsOfService], db: h.db });
  apps.push(app as unknown as TestApp);
  return app;
}

type App = Awaited<ReturnType<typeof start>>;

/** Runs `fn` in a unit of work of the app's dispatcher: its tracked writes flush to the sinks. */
function write<T>(app: App, fn: (db: PrismaClient) => Promise<T>): Promise<T> {
  return app.server.dispatcher.run(async () => await fn(h.db));
}

/** ada, watching cy's list. */
async function watcher(app: App) {
  const connection = await app.connect(as(board.ada));
  const scopes = receiveScopes(connection);
  const request = { s: "projectsOfService", c: "of", scope: board.cy };
  return {
    scopes,
    subscribe: () => emitWithAck(connection.socket, "qd:col:sub", request),
    items: (ids: readonly string[]) =>
      emitWithAck(connection.socket, "qd:col:items", { ...request, ids }),
    deltas: () => scopes.frames.map((frame: CollectionFrame) => frame.deltas),
  };
}

describe("a via list over the item service's members table", () => {
  it("drops a member whose role falls below the list's access, and adds them back", async () => {
    const app = await start();
    const ada = await watcher(app);
    expect(await ada.subscribe()).toMatchObject({ ok: true, items: [{ id: board.p1 }] });
    await write(app, (db) =>
      db.projectMember.updateMany({
        where: { projectId: board.p1, userId: board.cy },
        data: { role: "Public" },
      }),
    );
    await ada.scopes.settle();
    expect(ada.deltas()).toEqual([[{ t: "removed", id: board.p1 }]]);
    expect(await ada.subscribe()).toMatchObject({ ok: true, items: [], total: 0 });
    expect(await ada.items([board.p1])).toMatchObject({ ok: true, items: [] });
    ada.scopes.clear();
    await write(app, (db) =>
      db.projectMember.updateMany({
        where: { projectId: board.p1, userId: board.cy },
        data: { role: "Read" },
      }),
    );
    await ada.scopes.settle();
    expect(ada.deltas()).toEqual([[{ t: "added", item: { id: board.p1, name: "P1" } }]]);
  });

  it("does not add a link created below the list's access", async () => {
    const app = await start();
    const ada = await watcher(app);
    await ada.subscribe();
    await write(app, (db) =>
      db.projectMember.create({ data: { projectId: board.p2, userId: board.cy, role: "Public" } }),
    );
    await ada.scopes.settle();
    expect(ada.deltas()).toEqual([]);
  });

  it("costs no new statement", async () => {
    await start();
    const counted = await h.storage.countStatements(() =>
      h.inUnit(() =>
        h.db.projectMember.updateMany({
          where: { projectId: board.p1, userId: board.cy },
          data: { role: "Moderate" },
        }),
      ),
    );
    expect(counted.statements).toBe(STATEMENTS);
  });
});

/** The statements of the role update above, measured before the rule: its rows read first, then the write. */
const STATEMENTS = 2;
