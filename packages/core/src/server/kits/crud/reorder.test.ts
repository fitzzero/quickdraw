// The read/write kit's `reorder` and `nextOrdinal` (RFC 0003 section 12.1)
// against PGlite: a move takes the whole number halfway between its new
// neighbors and writes one row; when no gap is left, the list is renumbered
// in steps, in a second transaction given time for every row; both run
// SERIALIZABLE, a conflict being `CONFLICT`; neighbors must be rows of the
// same list.

import { describe, expect, it } from "vitest";
import { createTestApp, type TestApp } from "../../../testing/index";
import { colSub, receiveScopes } from "../../collections/__tests__/fixture";
import { projectService } from "../../emit/__tests__/live";
import { nextOrdinal, ORDINAL_STEP } from "../../index";
import { addTasks, as, defineTaskService, kitApp } from "./__tests__/fixture";
import { ordinalBetween } from "./ordinal";
import { RENUMBER_BASE_MS, RENUMBER_MS_PER_ROW } from "./reorder";

const kit = kitApp();

/** The ids of P's tasks in the list's order, with their ordinals. */
async function order(projectId: string): Promise<[string, number][]> {
  const rows = await kit.harness().prisma.task.findMany({
    where: { projectId },
    orderBy: [{ ordinal: "asc" }, { id: "asc" }],
    select: { id: true, ordinal: true },
  });
  return rows.map((row) => [row.id, row.ordinal]);
}

describe("reorder", () => {
  it("moves a row between two neighbors, writing only that row", async () => {
    const { app } = await kit.start();
    const board = kit.board();
    const [a = "", b = "", c = ""] = await addTasks(
      kit.harness().prisma,
      board.p1,
      [1024, 2048, 3072],
    );
    const connection = await app.connect(as(board.cy));
    const scopes = receiveScopes(connection);
    await colSub(connection, "board", board.p1);
    const moved = await app
      .as(as(board.bo))
      .taskService.reorder({ id: c, beforeId: a, afterId: b });
    expect(moved).toMatchObject({ id: c, ordinal: 1536 });
    expect(await order(board.p1)).toEqual([
      [board.t1, 0],
      [a, 1024],
      [c, 1536],
      [b, 2048],
    ]);
    await scopes.settle();
    expect(scopes.frames.flatMap((frame) => frame.deltas)).toEqual([
      { t: "patched", id: c, d: { ordinal: 1536 } },
    ]);
  });

  it("finds the other neighbor when given one, and moves to either end", async () => {
    const { app } = await kit.start();
    const board = kit.board();
    const [a = "", b = "", c = ""] = await addTasks(
      kit.harness().prisma,
      board.p1,
      [1024, 2048, 3072],
    );
    const member = app.as(as(board.bo)).taskService;
    // After a: between a and b.
    expect(await member.reorder({ id: c, beforeId: a })).toMatchObject({ ordinal: 1536 });
    // Before T1, the first row: a step below it.
    expect(await member.reorder({ id: b, afterId: board.t1 })).toMatchObject({
      ordinal: -ORDINAL_STEP,
    });
    // After the last row, c: a step above it.
    expect(await member.reorder({ id: board.t1, beforeId: c })).toMatchObject({
      ordinal: 1536 + ORDINAL_STEP,
    });
    expect(await order(board.p1)).toEqual([
      [b, -ORDINAL_STEP],
      [a, 1024],
      [c, 1536],
      [board.t1, 1536 + ORDINAL_STEP],
    ]);
  });

  it("renumbers the list in steps when no gap is left", async () => {
    const { app } = await kit.start();
    const board = kit.board();
    const prisma = kit.harness().prisma;
    const [a = "", b = "", c = "", d = ""] = await addTasks(prisma, board.p1, [1, 2, 3, 4]);
    const other = await addTasks(prisma, board.p2, [1, 2]);
    const moved = await app
      .as(as(board.bo))
      .taskService.reorder({ id: d, beforeId: a, afterId: b });
    expect(await order(board.p1)).toEqual([
      [board.t1, ORDINAL_STEP],
      [a, 2 * ORDINAL_STEP],
      [d, 3 * ORDINAL_STEP],
      [b, 4 * ORDINAL_STEP],
      [c, 5 * ORDINAL_STEP],
    ]);
    expect(moved).toMatchObject({ id: d, ordinal: 3 * ORDINAL_STEP });
    // Another project's list is not touched.
    expect((await order(board.p2)).map(([, ordinal]) => ordinal)).toEqual([0, 1, 2]);
    expect(other).toHaveLength(2);
    // Ties count as no gap too; ties are ordered by id, the order the rows were made in.
    await prisma.task.updateMany({ where: { projectId: board.p1 }, data: { ordinal: 7 } });
    await app.as(as(board.bo)).taskService.reorder({ id: c, beforeId: a, afterId: b });
    expect(await order(board.p1)).toEqual(
      [board.t1, a, c, b, d].map((id, index): [string, number] => [id, (index + 1) * ORDINAL_STEP]),
    );
  });

  it("refuses neighbors of another list as missing ones, and neighbors out of order", async () => {
    const { app } = await kit.start();
    const board = kit.board();
    const [a = "", b = ""] = await addTasks(kit.harness().prisma, board.p1, [1024, 2048]);
    const member = app.as(as(board.bo)).taskService as unknown as {
      reorder(input: unknown): Promise<unknown>;
    };
    // A row of another list is answered like a missing one: no way to tell them apart.
    await expect(member.reorder({ id: a, beforeId: board.t2 })).rejects.toMatchObject({
      code: "NOT_FOUND",
      message: "No such task in this list as beforeId",
    });
    await expect(member.reorder({ id: a, afterId: "missing" })).rejects.toMatchObject({
      code: "NOT_FOUND",
    });
    await expect(member.reorder({ id: board.t1, beforeId: b, afterId: a })).rejects.toMatchObject({
      code: "VALIDATION",
      data: { issues: [{ path: ["afterId"] }] },
    });
    await expect(member.reorder({ id: a })).rejects.toMatchObject({ code: "VALIDATION" });
    await expect(member.reorder({ id: a, beforeId: a })).rejects.toMatchObject({
      code: "VALIDATION",
      data: { issues: [{ path: ["beforeId"] }] },
    });
    // A reader may not move rows.
    await expect(
      app.as(as(board.cy)).taskService.reorder({ id: a, beforeId: b }),
    ).rejects.toMatchObject({ code: "FORBIDDEN" });
  });
});

describe("ordinals", () => {
  it("takes the whole number halfway, or a step past an end, within 32 bits", () => {
    expect(ordinalBetween(1024, 2048)).toBe(1536);
    expect(ordinalBetween(1, 3)).toBe(2);
    expect(ordinalBetween(1, 2)).toBeUndefined();
    expect(ordinalBetween(5, 5)).toBeUndefined();
    expect(ordinalBetween(1.5, 2.25)).toBeUndefined();
    expect(ordinalBetween(undefined, 0)).toBe(-ORDINAL_STEP);
    expect(ordinalBetween(10, undefined)).toBe(10 + ORDINAL_STEP);
    expect(ordinalBetween(2_147_483_000, undefined)).toBeUndefined();
    expect(ordinalBetween(undefined, -2_147_483_000)).toBeUndefined();
  });

  it("puts a new row last with nextOrdinal", async () => {
    const board = kit.board();
    const { prisma, db } = kit.harness();
    expect(await nextOrdinal(db, "task", { projectId: board.p1 })).toBe(ORDINAL_STEP);
    await addTasks(prisma, board.p1, [40, 7]);
    expect(await nextOrdinal(db, "task", { projectId: board.p1 })).toBe(40 + ORDINAL_STEP);
    expect(await nextOrdinal(db, "Task", { projectId: "none" }, { column: "ordinal" })).toBe(
      ORDINAL_STEP,
    );
    await expect(nextOrdinal(db, "")).rejects.toThrow(TypeError);
  });
});

describe("reorder's transactions", () => {
  /** The harness's tracked client, its `$transaction` recording its options and failing on demand. */
  function watchedDb(fail: () => Error | undefined) {
    const db = kit.harness().db;
    const options: unknown[] = [];
    const watched = new Proxy(db, {
      get(target, key) {
        if (key !== "$transaction") {
          return Reflect.get(target, key) as unknown;
        }
        return async (fn: unknown, given?: unknown) => {
          options.push(given);
          const error = fail();
          if (error !== undefined) {
            throw error;
          }
          return await target.$transaction(fn as never, given as never);
        };
      },
    });
    return { db: watched, options };
  }

  it("are SERIALIZABLE, a renumbering one given time for every row, and a conflict is CONFLICT", async () => {
    let fail: (() => Error) | undefined;
    const { db, options } = watchedDb(() => fail?.());
    const app = await createTestApp({ services: [projectService, defineTaskService()], db });
    kit.track(app as unknown as TestApp);
    const board = kit.board();
    const prisma = kit.harness().prisma;
    const [a = "", b = "", c = ""] = await addTasks(prisma, board.p1, [1024, 2048, 3072]);
    const bo = app.as(as(board.bo)).taskService;
    // A gap: one transaction.
    await bo.reorder({ id: c, beforeId: a, afterId: b });
    expect(options).toEqual([{ isolationLevel: "Serializable" }]);
    // Every ordinal alike: no gap is left anywhere.
    await prisma.task.updateMany({ where: { projectId: board.p1 }, data: { ordinal: 5 } });
    options.length = 0;
    await bo.reorder({ id: c, beforeId: a, afterId: b });
    // The first finds no gap and writes nothing; the second renumbers P1's four tasks (the
    // count is of the list without the moved row, whose time is added).
    expect(options).toEqual([
      { isolationLevel: "Serializable" },
      { isolationLevel: "Serializable", timeout: RENUMBER_BASE_MS + 4 * RENUMBER_MS_PER_ROW },
    ]);
    expect((await order(board.p1)).map(([id]) => id)).toEqual([board.t1, a, c, b]);
    // A conflict the database reports at commit (SSI: two moves into one gap at once).
    fail = () =>
      Object.assign(new Error("TransactionWriteConflict"), {
        name: "DriverAdapterError",
        cause: { kind: "TransactionWriteConflict", originalCode: "40001" },
      });
    await expect(bo.reorder({ id: a, beforeId: c, afterId: b })).rejects.toMatchObject({
      code: "CONFLICT",
      message: "Another change to this list ran at the same time; try again",
    });
    fail = () =>
      Object.assign(new Error("P2034"), { name: "PrismaClientKnownRequestError", code: "P2034" });
    await expect(bo.reorder({ id: a, beforeId: c, afterId: b })).rejects.toMatchObject({
      code: "CONFLICT",
    });
  });
});
