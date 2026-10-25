// Nested interactive transactions (RFC 0003 section 5.2). Prisma 7 runs
// `tx.$transaction(...)` inside an interactive transaction as a savepoint
// of it. Its writes join the transaction around it once the savepoint is
// released, and a rollback of the savepoint drops them, even when the
// transaction around it catches the error and commits: before, both went
// into the outer transaction's frame, so a rolled-back savepoint's rows were
// still sent. PGlite runs the savepoints as PostgreSQL does, through the
// three methods test/prisma/setup.ts gives its adapter (adapter-pg's SQL).

import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { WriteRecord } from "../server/uow/types";
import { createHarness, type Harness } from "./__tests__/harness";

let h: Harness;
let projectId: string;

beforeAll(async () => {
  h = await createHarness();
}, 60_000);

afterAll(async () => {
  await h.close();
});

beforeEach(async () => {
  await h.database.reset();
  ({ projectId } = await h.seed());
});

/** The flushed writes as `op id`. */
const ops = (writes: readonly WriteRecord[]): string[] =>
  writes.map((write) => `${write.op} ${write.id}`);

/** The tasks the database holds, by id. */
async function rows(): Promise<string[]> {
  return (await h.prisma.task.findMany({ orderBy: { id: "asc" } })).map((task) => task.id);
}

const UNDONE = "roll the savepoint back";

describe("a transaction nested in an interactive one", () => {
  it("drops its writes when it rolls back, while the one around it commits its own", async () => {
    await h.prisma.task.create({ data: { id: "kept", projectId, title: "kept" } });
    const { writes } = await h.inUnit(() =>
      h.db.$transaction(async (tx) => {
        await tx.task.create({ data: { id: "a", projectId, title: "a" } });
        await expect(
          tx.$transaction(async (inner) => {
            await inner.task.create({ data: { id: "b", projectId, title: "b" } });
            await inner.task.update({ where: { id: "kept" }, data: { status: "done" } });
            // Its ids are read through the savepoint's client: it sees the row created there.
            await inner.task.updateMany({ where: { projectId }, data: { ordinal: 5 } });
            throw new Error(UNDONE);
          }),
        ).rejects.toThrow(UNDONE);
        await tx.task.update({ where: { id: "kept" }, data: { title: "renamed" } });
      }),
    );
    expect(await rows()).toEqual(["a", "kept"]);
    expect(await h.prisma.task.findUniqueOrThrow({ where: { id: "kept" } })).toMatchObject({
      title: "renamed",
      status: "open",
      ordinal: 0,
    });
    // Neither b, nor the status and ordinal the savepoint set and lost.
    expect(writes).toEqual([
      expect.objectContaining({ id: "a", op: "create" }),
      expect.objectContaining({ id: "kept", op: "update", fields: ["title"] }),
    ]);
    expect(writes[1]?.after).toMatchObject({ status: "open" });
  });

  it("joins the one around it when it commits: sent once that commits, never if it rolls back", async () => {
    const committed = await h.inUnit(() =>
      h.db.$transaction(async (tx) => {
        await tx.task.create({ data: { id: "a", projectId, title: "a" } });
        await tx.$transaction(async (inner) => {
          await inner.task.create({ data: { id: "b", projectId, title: "b" } });
          // The storage adapter reads through the savepoint's client too.
          expect(await h.storage.count("task", { where: { id: { in: ["a", "b"] } } })).toBe(2);
        });
      }),
    );
    expect(ops(committed.writes)).toEqual(["create a", "create b"]);
    await h.database.reset();
    ({ projectId } = await h.seed());
    const rolledBack = await h.inUnit(async () => {
      await expect(
        h.db.$transaction(async (tx) => {
          await tx.task.create({ data: { id: "a", projectId, title: "a" } });
          await tx.$transaction(async (inner) => {
            await inner.task.create({ data: { id: "b", projectId, title: "b" } });
          });
          throw new Error("roll everything back");
        }),
      ).rejects.toThrow("roll everything back");
    });
    expect(await rows()).toEqual([]);
    expect(rolledBack.writes).toEqual([]);
  });

  it("nests deeper: a savepoint rolled back drops the ones released into it, and the next is sent", async () => {
    const { writes } = await h.inUnit(() =>
      h.db.$transaction(async (tx) => {
        await tx.task.create({ data: { id: "a", projectId, title: "a" } });
        await expect(
          tx.$transaction(async (middle) => {
            await middle.task.create({ data: { id: "b", projectId, title: "b" } });
            await middle.$transaction(async (innermost) => {
              await innermost.task.create({ data: { id: "c", projectId, title: "c" } });
            });
            throw new Error(UNDONE);
          }),
        ).rejects.toThrow(UNDONE);
        await tx.$transaction(async (again) => {
          await again.task.create({ data: { id: "e", projectId, title: "e" } });
        });
      }),
    );
    expect(await rows()).toEqual(["a", "e"]);
    expect(ops(writes)).toEqual(["create a", "create e"]);
  });

  it("tracks the array form nested in one, and leaves the client's own calls as Prisma's", async () => {
    const { value, writes } = await h.inUnit(() =>
      h.db.$transaction(async (tx) => {
        await tx.$transaction([
          tx.task.create({ data: { id: "f", projectId, title: "f" } }),
          tx.task.create({ data: { id: "g", projectId, title: "g" } }),
        ]);
        const [{ total } = { total: 0n }] = await tx.$queryRaw<
          { total: bigint }[]
        >`SELECT count(*) AS total FROM "Task"`;
        return { total, counted: await tx.task.count() };
      }),
    );
    expect(value).toEqual({ total: 2n, counted: 2 });
    expect(ops(writes)).toEqual(["create f", "create g"]);
  });
});
