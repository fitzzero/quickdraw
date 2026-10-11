// A deleted `via` entry, and the removals nobody can name (the 5.1 audit's
// COLL-3, as reviewed): a filtered list is never told of an entry deleted
// outside its `where`; a removal nobody can name costs every scope of its
// collection the resume, subscribed here or not; and a deleted entry whose
// links were read costs a collection nobody here subscribes to only its
// linked scopes' resumes.
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
import { as, seedBoard, type Board } from "../access/__tests__/board";
import { projectContract, projectService, qd } from "../emit/__tests__/live";
import { inherit, type AnyService } from "../index";
import {
  colSub,
  colUnsub,
  defineTaskService,
  labelContract,
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

/** The open tasks a label is on: a `via` list filtered by `where`. */
const openContract = defineContract("openTaskService", {
  entity: z.object({ id: z.string(), title: z.string(), status: z.string() }),
  methods: {},
  collections: {
    openByLabel: {
      scope: via({ model: "taskLabel", entry: "taskId", scope: "labelId" }),
      item: "entity",
      where: { status: "open" },
      order: [["id", "asc"]],
    },
  },
});

const openService = qd.defineService(openContract, {
  model: "task",
  access: inherit({ from: projectContract, via: "projectId" }),
  collections: { openByLabel: { anchor: labelContract } },
  methods: {},
});

async function start(service: AnyService = defineTaskService()) {
  const app = await createTestApp({ services: [projectService, labelService, service], db: h.db });
  apps.push(app as unknown as TestApp);
  return app;
}

type App = Awaited<ReturnType<typeof start>>;

function write<T>(app: App, fn: (db: PrismaClient) => Promise<T>): Promise<T> {
  return app.server.dispatcher.run(async () => await fn(h.db));
}

/** A label of P1 holding the given tasks. */
async function labelOn(name: string, taskIds: readonly string[]): Promise<string> {
  const label = await h.prisma.label.create({ data: { projectId: board.p1, name } });
  for (const taskId of taskIds) {
    await h.prisma.taskLabel.create({ data: { taskId, labelId: label.id } });
  }
  return label.id;
}

describe("a deleted via entry (COLL-3)", () => {
  it("is never told to a filtered list it was outside of when deleted", async () => {
    const open = await h.prisma.task.create({ data: { projectId: board.p1, title: "Open" } });
    await h.prisma.task.update({ where: { id: board.t1 }, data: { status: "closed" } });
    const bug = await labelOn("Bug", [board.t1, open.id]);
    const app = await start(openService);
    const connection = await app.connect(as(board.ada));
    const scopes = receiveScopes(connection);
    const page = await emitWithAck(connection.socket, "qd:col:sub", {
      s: "openTaskService",
      c: "openByLabel",
      scope: bug,
    });
    expect(page).toMatchObject({ ok: true, items: [{ id: open.id }] });
    await write(app, (db) => db.task.delete({ where: { id: board.t1 } }));
    await write(app, (db) => db.task.delete({ where: { id: open.id } }));
    await scopes.settle();
    expect(scopes.frames.map((frame: CollectionFrame) => frame.deltas)).toEqual([
      [{ t: "removed", id: open.id }],
    ]);
  });
});

describe.skipIf(inCluster())("resume across a delete", () => {
  it("costs every scope of a collection its resume for a removal nobody can name, subscribed here or not", async () => {
    const app = await start();
    // ed keeps P2's scope subscribed here, so the flush builds the collection's frames.
    const ed = await app.connect(as(board.ed));
    await colSub(ed, "byProject", board.p2);
    const ada = await app.connect(as(board.ada));
    const first = await colSub(ada, "byProject", board.p1);
    await colUnsub(ada, "byProject", board.p1);
    await write(app, () =>
      Promise.resolve(h.storage.unitOfWork.touch?.("task", [board.t1], { removed: true })),
    );
    const back = await colSub(ada, "byProject", board.p1, { since: first.rev as number });
    expect(back).toMatchObject({ ok: true, items: expect.any(Array) });
    expect(back.resumed).toBeUndefined();
  });

  it("costs a collection nobody here subscribes to only the linked scopes' resumes", async () => {
    const other = await h.prisma.task.create({ data: { projectId: board.p1, title: "Other" } });
    await labelOn("Bug", [board.t1]);
    const idea = await labelOn("Idea", [other.id]);
    const app = await start();
    const ada = await app.connect(as(board.ada));
    const first = await colSub(ada, "byLabel", idea);
    await colUnsub(ada, "byLabel", idea);
    // T1 was linked to Bug alone: its delete names that scope, and the Idea scope keeps its resume.
    await write(app, (db) => db.task.delete({ where: { id: board.t1 } }));
    const back = await colSub(ada, "byLabel", idea, { since: first.rev as number });
    expect(back).toMatchObject({ ok: true, resumed: true, deltas: [] });
  });
});
