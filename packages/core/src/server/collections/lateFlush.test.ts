// One server decides a collection delta by the row as read for the frame
// (the 5.1 audit's COLL-2, decision D19 (2)): a flush that runs after later
// units moved its rows (behind a slow handler tail, or waiting in a busy
// queue) must not send a row's new values to the scope it left. A cluster
// decides at the read already (`deltas.ts`); these sequences need one
// process.
//
//            owner   access list    members
//   P1       ada     di: Read       bo: Moderate, cy: Read
//   P2       ed      -              -
//   T1 in P1, T2 in P2

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { inCluster } from "../../../test/cluster/mode";
import type { PrismaClient } from "../../../test/prisma/setup";
import type { CollectionFrame } from "../../index";
import { createHarness, type Harness } from "../../prisma/__tests__/harness";
import { createTestApp, type TestApp } from "../../testing/index";
import { as, seedBoard, type Board } from "../access/__tests__/board";
import { projectService } from "../emit/__tests__/live";
import type { FlushSink } from "../index";
import { colSub, defineTaskService, labelService, receiveScopes } from "./__tests__/fixture";

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

async function start(flushSink?: FlushSink) {
  const app = await createTestApp({
    services: [projectService, labelService, defineTaskService()],
    db: h.db,
    ...(flushSink === undefined ? {} : { flushSink }),
  });
  apps.push(app as unknown as TestApp);
  return app;
}

type App = Awaited<ReturnType<typeof start>>;

function write<T>(app: App, fn: (db: PrismaClient) => Promise<T>): Promise<T> {
  return app.server.dispatcher.run(async () => await fn(h.db));
}

/** A promise, and the function that resolves it. */
function gate(): { readonly wait: Promise<void>; readonly open: () => void } {
  let open = (): void => undefined;
  const wait = new Promise<void>((resolve) => {
    open = resolve;
  });
  return { wait, open };
}

/** cy, a Read member of P1 who may not open P2, watching P1's tasks. */
async function watcher(app: App) {
  const connection = await app.connect(as(board.cy));
  const scopes = receiveScopes(connection);
  expect(await colSub(connection, "byProject", board.p1)).toMatchObject({ ok: true });
  expect(await colSub(connection, "byProject", board.p2)).toMatchObject({ ok: false });
  return {
    scopes,
    deltas: () => scopes.frames.flatMap((frame: CollectionFrame) => frame.deltas),
  };
}

describe.skipIf(inCluster())("a flush that runs after later units moved its rows (COLL-2)", () => {
  it("sends a row moved since to the scope it left as removed: a slow handler tail", async () => {
    const app = await start();
    const cy = await watcher(app);
    const renamed = gate();
    const tail = gate();
    const slow = write(app, async (db) => {
      await db.task.update({ where: { id: board.t1 }, data: { title: "Renamed in P1" } });
      renamed.open();
      await tail.wait;
    });
    await renamed.wait;
    await write(app, (db) =>
      db.task.update({
        where: { id: board.t1 },
        data: { projectId: board.p2, title: "P2 SECRET: acquisition target" },
      }),
    );
    tail.open();
    await slow;
    await cy.scopes.settle();
    const deltas = cy.deltas();
    expect(deltas.length).toBeGreaterThan(0);
    expect(deltas).toEqual(deltas.map(() => ({ t: "removed", id: board.t1 })));
    expect(JSON.stringify(cy.scopes.frames)).not.toContain("P2 SECRET");
  });

  it("adds no row created in the scope and moved out before its flush", async () => {
    const app = await start();
    const cy = await watcher(app);
    const created = gate();
    const tail = gate();
    let id = "";
    const slow = write(app, async (db) => {
      ({ id } = await db.task.create({ data: { projectId: board.p1, title: "Fresh" } }));
      created.open();
      await tail.wait;
    });
    await created.wait;
    await write(app, (db) =>
      db.task.update({ where: { id }, data: { projectId: board.p2, status: "confidential" } }),
    );
    tail.open();
    await slow;
    await cy.scopes.settle();
    expect(cy.deltas().filter((delta) => delta.t !== "removed")).toEqual([]);
    expect(JSON.stringify(cy.scopes.frames)).not.toContain("confidential");
  });

  it("sends a row moved while its flush waited behind a busy queue as removed", async () => {
    let once = true;
    const busy = gate();
    const app = await start({
      flush: async (writes) => {
        if (once && writes.some((record) => record.model === "project")) {
          once = false;
          busy.open();
          await new Promise((resolve) => {
            setTimeout(resolve, 300);
          });
        }
      },
    });
    const cy = await watcher(app);
    const queued = write(app, (db) =>
      db.project.update({ where: { id: board.p2 }, data: { name: "Busy" } }),
    );
    await busy.wait;
    const noted = gate();
    const late = write(app, async (db) => {
      await db.task.update({ where: { id: board.t1 }, data: { notes: "Queued" } });
      noted.open();
    });
    await noted.wait;
    const moved = write(app, (db) =>
      db.task.update({
        where: { id: board.t1 },
        data: { projectId: board.p2, title: "P2 SECRET from the queue" },
      }),
    );
    await Promise.all([queued, late, moved]);
    await cy.scopes.settle();
    expect(JSON.stringify(cy.scopes.frames)).not.toContain("P2 SECRET");
    expect(cy.deltas().filter((delta) => delta.t !== "removed")).toEqual([]);
  });
});
