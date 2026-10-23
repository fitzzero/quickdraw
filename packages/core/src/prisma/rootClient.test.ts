// The root client inside a transaction's callback (RFC 0003 section 5.2).
// Work on `db` there runs outside the transaction, on a connection of its
// own: a write commits at once, a `db.$transaction` commits on its own, and
// `createMany` and `updateMany` stay root writes. The tracker used to record
// all of it into the transaction's frame, by `AsyncLocalStorage`, so a
// rollback of the transaction dropped the frames of rows that stayed, and
// the hook ran a root `createMany` or `updateMany` as its `...AndReturn`
// form through the transaction's client, moving the write into it.
//
// PGlite has one connection: the root client's work waits there until the
// transaction ends, which its `timeout` does in these tests (on PostgreSQL
// it runs at once). Either way it completes while the transaction's frame
// is open, and commits whatever the transaction then does.

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

/** Long enough for the transaction's own statements, short enough to end the wait for the root client's. */
const ENDS = { timeout: 1000 };

const UNDONE = "roll the transaction back";

/** The flushed writes as `op id`. */
const ops = (writes: readonly WriteRecord[]): string[] =>
  writes.map((write) => `${write.op} ${write.id}`);

/** The tasks the database holds, as `id:status`. */
async function rows(): Promise<string[]> {
  return (await h.prisma.task.findMany({ orderBy: { id: "asc" } })).map(
    (task) => `${task.id}:${task.status}`,
  );
}

describe("the root client inside a transaction's callback", () => {
  it("flushes a write the transaction's rollback leaves in place, and none of the transaction's", async () => {
    const { writes } = await h.inUnit(async () => {
      await expect(
        h.db.$transaction(async (tx) => {
          await tx.task.create({ data: { id: "a", projectId, title: "a" } });
          await h.db.task.create({ data: { id: "d", projectId, title: "d" } });
          throw new Error(UNDONE);
        }, ENDS),
      ).rejects.toThrow();
    });
    expect(await rows()).toEqual(["d:open"]);
    expect(ops(writes)).toEqual(["create d"]);
  });

  it("runs createMany and updateMany on the root client, outside the transaction", async () => {
    await h.prisma.task.create({ data: { id: "old", projectId, title: "old" } });
    const { writes } = await h.inUnit(async () => {
      await expect(
        h.db.$transaction(async (tx) => {
          await tx.task.create({ data: { id: "a", projectId, title: "a" } });
          await h.db.task.createMany({
            data: [
              { id: "e1", projectId, title: "e1" },
              { id: "e2", projectId, title: "e2" },
            ],
          });
          await h.db.task.updateMany({ where: { id: "old" }, data: { status: "touched" } });
          throw new Error(UNDONE);
        }, ENDS),
      ).rejects.toThrow();
    });
    expect(await rows()).toEqual(["e1:open", "e2:open", "old:touched"]);
    expect(ops(writes)).toEqual(["create e1", "create e2", "update old"]);
    expect(writes[2]).toMatchObject({ before: { status: "open" }, after: { status: "touched" } });
  });

  it("flushes a transaction of its own begun there, an interactive or an array-form one", async () => {
    const { writes } = await h.inUnit(async () => {
      await expect(
        h.db.$transaction(async (tx) => {
          await tx.task.create({ data: { id: "a", projectId, title: "a" } });
          await h.db.$transaction(async (own) => {
            await own.task.create({ data: { id: "t2", projectId, title: "t2" } });
          });
          await h.db.$transaction([
            h.db.task.create({ data: { id: "b1", projectId, title: "b1" } }),
          ]);
          throw new Error(UNDONE);
        }, ENDS),
      ).rejects.toThrow();
    });
    expect(await rows()).toEqual(["b1:open", "t2:open"]);
    expect(ops(writes)).toEqual(["create t2", "create b1"]);
  });

  it("leaves a transaction that commits as it was, its own writes and the root client's", async () => {
    const { writes } = await h.inUnit(() =>
      h.db.$transaction(async (tx) => {
        await tx.task.create({ data: { id: "a", projectId, title: "a" } });
        await tx.task.update({ where: { id: "a" }, data: { status: "done" } });
        // A transaction client's createMany stays in the transaction, read through its client.
        await tx.task.createMany({ data: [{ id: "c", projectId, title: "c" }] });
        await tx.task.updateMany({ where: { id: "c" }, data: { status: "doing" } });
      }),
    );
    expect(await rows()).toEqual(["a:done", "c:doing"]);
    expect(ops(writes)).toEqual(["create a", "create c"]);
    expect(writes[1]?.after).toMatchObject({ status: "doing" });
  });
});
