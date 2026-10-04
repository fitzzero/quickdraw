// Tracked writes across units of work and transactions (RFC 0003 sections
// 5.1 and 5.2), against PGlite with the real generated client. These port
// the planner's spike (`track.ts` on the tracked-writes card) to tests; each
// test names the spike check it covers.

import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { storageOf } from "../server/storage";
import type { WriteRecord } from "../server/uow/types";
import { createRecordingSink } from "../testing/recordingSink";
import { createHarness, nextTick, type Harness } from "./__tests__/harness";
import { trackPrisma } from "./trackPrisma";

let h: Harness;
let projectId: string;
let userId: string;

beforeAll(async () => {
  h = await createHarness();
}, 60_000);

afterAll(async () => {
  await h.close();
});

beforeEach(async () => {
  await h.database.reset();
  h.logger.warnings.length = 0;
  ({ projectId, userId } = await h.seed());
});

describe("units of work", () => {
  it("records create, update and delete with ids and fields (spike check 1)", async () => {
    const created = await h.inUnit(() => h.db.task.create({ data: { projectId, title: "t1" } }));
    const { id } = created.value;
    const updated = await h.inUnit(() =>
      h.db.task.update({ where: { id }, data: { title: "t2" } }),
    );
    const deleted = await h.inUnit(() => h.db.task.delete({ where: { id } }));
    expect([...created.writes, ...updated.writes, ...deleted.writes]).toEqual([
      expect.objectContaining({ id, op: "create", fields: ["projectId", "title"] }),
      expect.objectContaining({ id, op: "update", fields: ["title"] }),
      expect.objectContaining({ id, op: "delete", fields: [] }),
    ]);
  });

  it("tracks a Prisma promise the function returns without awaiting it (spike check 13)", async () => {
    const task = await h.prisma.task.create({ data: { projectId, title: "lazy" } });
    const { writes } = await h.inUnit(() =>
      h.db.task.update({ where: { id: task.id }, data: { title: "returned, not awaited" } }),
    );
    expect(writes).toEqual([expect.objectContaining({ id: task.id, op: "update" })]);
  });

  it("misses a Prisma promise created in the unit but awaited after it (the trap of check 13)", async () => {
    const ambient = createRecordingSink();
    h.storage.unitOfWork.attach?.(ambient, h.logger);
    let escaped: PromiseLike<unknown> | undefined;
    const { writes } = await h.inUnit(() => {
      escaped = h.db.task.create({ data: { projectId, title: "escaped" } });
      return "not awaited here";
    });
    expect(await h.prisma.task.count()).toBe(0);
    await escaped;
    expect(writes).toEqual([]);
    expect((await ambient.next()).writes).toEqual([expect.objectContaining({ op: "create" })]);
  });

  it("merges ten updates to one row into one record with the union of fields", async () => {
    const task = await h.prisma.task.create({ data: { projectId, title: "busy" } });
    const { writes } = await h.inUnit(async () => {
      for (let index = 0; index < 10; index += 1) {
        await h.db.task.update({
          where: { id: task.id },
          data: index % 2 === 0 ? { title: `t${index}` } : { ordinal: index, status: "doing" },
        });
      }
    });
    expect(writes).toHaveLength(1);
    expect(writes[0]).toMatchObject({ id: task.id, op: "update", before: { status: "open" } });
    expect([...(writes[0]?.fields ?? [])].sort()).toEqual(["ordinal", "status", "title"]);
  });

  it("flushes a write made outside any unit of work on the next tick (spike check 12)", async () => {
    // A client of its own: the warning is given once per client and model.
    const db = trackPrisma(h.prisma, { development: true });
    const ambient = createRecordingSink();
    storageOf(db)?.unitOfWork.attach?.(ambient, h.logger);
    const task = await db.task.create({ data: { projectId, title: "ambient" } });
    await db.task.update({ where: { id: task.id }, data: { title: "still ambient" } });
    expect(ambient.flushes).toEqual([]);
    await nextTick();
    expect(ambient.flushes).toHaveLength(1);
    expect(ambient.writes()).toEqual([expect.objectContaining({ id: task.id, op: "create" })]);
    expect(h.logger.warnings).toEqual([
      expect.stringContaining("A tracked write to task ran outside any unit of work"),
    ]);
  });

  it("counts every statement, reads included (spike check 11)", async () => {
    const counted = await h.storage.countStatements(async () => {
      await h.db.user.findMany({ take: 1 });
      await h.db.task.findMany({ take: 1 });
      await h.db.task.count();
      await h.db.$queryRaw`SELECT 1`;
    });
    expect(counted.statements).toBe(4);
  });
});

describe("interactive transactions", () => {
  it("merge their writes into the unit when they commit (spike check 3)", async () => {
    const { writes } = await h.inUnit(() =>
      h.db.$transaction(async (tx) => {
        const task = await tx.task.create({ data: { projectId, title: "in tx" } });
        await tx.projectMember.create({ data: { projectId, userId, role: "Admin" } });
        await tx.task.update({ where: { id: task.id }, data: { status: "done" } });
      }),
    );
    expect(writes.map((write) => [write.model, write.op])).toEqual([
      ["task", "create"],
      ["projectMember", "create"],
    ]);
    expect(writes[0]?.after).toMatchObject({ status: "done" });
    expect(writes[1]?.after).toEqual({ projectId, userId, role: "Admin" });
  });

  it("drop their writes when they roll back, and leave no row (spike check 4)", async () => {
    const { writes } = await h.inUnit(async () => {
      await expect(
        h.db.$transaction(async (tx) => {
          await tx.task.create({ data: { projectId, title: "will roll back" } });
          throw new Error("boom");
        }),
      ).rejects.toThrow("boom");
    });
    expect(writes).toEqual([]);
    expect(await h.prisma.task.count()).toBe(0);
  });

  it("read updateMany and deleteMany ids through the transaction, seeing its own rows (spike check 6)", async () => {
    const seen: WriteRecord[] = [];
    const stop = h.storage.onWrite((write) => seen.push(write));
    try {
      const { writes } = await h.inUnit(() =>
        h.db.$transaction(async (tx) => {
          await tx.task.createMany({
            data: [
              { projectId, title: "a" },
              { projectId, title: "b" },
              { projectId, title: "c" },
            ],
          });
          await tx.task.updateMany({ where: { projectId }, data: { status: "edited" } });
          await tx.task.deleteMany({ where: { projectId, status: "edited" } });
        }),
      );
      // Each operation found the three rows the transaction created...
      expect(seen.map((write) => write.op)).toEqual([
        ...["create", "create", "create"],
        ...["update", "update", "update"],
        ...["delete", "delete", "delete"],
      ]);
      // ...and rows created and deleted in one unit flush nothing.
      expect(writes).toEqual([]);
    } finally {
      stop();
    }
    expect(await h.prisma.task.count()).toBe(0);
  });

  it("track a write the callback returns without awaiting it", async () => {
    const task = await h.prisma.task.create({ data: { projectId, title: "x" } });
    const { value, writes } = await h.inUnit(() =>
      h.db.$transaction((tx) =>
        tx.task.update({ where: { id: task.id }, data: { title: "returned" } }),
      ),
    );
    expect(value.title).toBe("returned");
    expect(writes).toEqual([expect.objectContaining({ id: task.id, op: "update" })]);
  });

  it("read through the transaction from the storage adapter too", async () => {
    const seen = await h.db.$transaction(async (tx) => {
      await tx.task.create({ data: { projectId, title: "uncommitted" } });
      return h.storage.count("task", { where: { title: "uncommitted" } });
    });
    expect(seen).toBe(1);
  });

  it("stay tracked on a client extended again after trackPrisma (spike check 10)", async () => {
    const extended = h.db.$extends({});
    const { writes } = await h.inUnit(async () => {
      await extended.$transaction(async (tx) => {
        await tx.task.create({ data: { projectId, title: "kept" } });
      });
      await extended
        .$transaction(async (tx) => {
          await tx.task.create({ data: { projectId, title: "dropped" } });
          throw new Error("roll back");
        })
        .catch(() => undefined);
    });
    expect(writes).toEqual([expect.objectContaining({ op: "create" })]);
    expect(await h.prisma.task.count()).toBe(1);
  });
});

describe("array-form transactions", () => {
  it("are tracked when the scope is set around the $transaction call (spike check 5)", async () => {
    const { writes } = await h.inUnit(() =>
      h.db.$transaction([
        h.db.task.create({ data: { projectId, title: "b1" } }),
        h.db.task.create({ data: { projectId, title: "b2" } }),
        h.db.task.count(),
      ]),
    );
    expect(writes.map((write) => write.op)).toEqual(["create", "create"]);
  });

  it("read updateMany's ids first, and track createMany only with explicit ids", async () => {
    await h.prisma.task.create({ data: { id: "t-open", projectId, title: "open" } });
    const { writes } = await h.inUnit(() =>
      h.db.$transaction([
        h.db.task.updateMany({ where: { projectId }, data: { status: "late" } }),
        h.db.task.createMany({ data: [{ id: "t-named", projectId, title: "named" }] }),
        h.db.task.createMany({ data: [{ projectId, title: "anonymous" }] }),
      ]),
    );
    expect(writes).toEqual([
      expect.objectContaining({ id: "t-open", op: "update", before: { status: "open" } }),
      expect.objectContaining({ id: "t-named", op: "create" }),
    ]);
    expect(await h.prisma.task.count()).toBe(3);
    expect(h.logger.warnings).toEqual([
      expect.stringContaining("updateMany on task inside an array-form $transaction reads"),
      expect.stringContaining("createMany on task inside an array-form $transaction"),
    ]);
  });

  it("warn once that deleteMany reads its rows outside the batch, which misses the batch's own", async () => {
    await h.prisma.task.create({ data: { id: "t-old", projectId, title: "old" } });
    const batch = () =>
      h.db.$transaction([
        h.db.task.create({ data: { id: `t-${crypto.randomUUID()}`, projectId, title: "new" } }),
        h.db.task.deleteMany({ where: { projectId } }),
      ]);
    const { writes } = await h.inUnit(batch);
    // Read outside the batch, the delete saw only the row that was there already:
    // the row the batch created is recorded as created, though the batch deleted it too.
    expect(writes.map(({ id, op }) => `${op} ${id}`).sort()).toEqual([
      expect.stringMatching(/^create t-/),
      "delete t-old",
    ]);
    expect(await h.prisma.task.count()).toBe(0);
    await h.inUnit(batch);
    expect(h.logger.warnings).toEqual([
      "[quickdraw:batch-read] deleteMany on task inside an array-form $transaction reads its rows first on the root client, outside the batch, so rows the batch's earlier statements changed may be missed; use an interactive transaction to read inside it",
    ]);
  });
});

describe("what is not tracked", () => {
  it("records only the parent of a nested write, with a warning (spike check 8)", async () => {
    const { writes } = await h.inUnit(() =>
      h.db.task.create({
        data: {
          projectId,
          title: "nested",
          subtasks: { create: [{ projectId, title: "child" }] },
          labels: { create: [] },
        },
      }),
    );
    expect(writes).toEqual([expect.objectContaining({ model: "task", op: "create" })]);
    expect(await h.prisma.task.count()).toBe(2);
    expect(h.logger.warnings).toEqual([
      expect.stringContaining("A nested write (task.subtasks: { create }) is not tracked"),
      expect.stringContaining("A nested write (task.labels: { create }) is not tracked"),
    ]);
  });

  it("records only the deleted row when the database cascades the delete (spike check 9)", async () => {
    await h.prisma.task.createMany({
      data: [
        { projectId, title: "a" },
        { projectId, title: "b" },
      ],
    });
    const { writes } = await h.inUnit(() => h.db.project.delete({ where: { id: projectId } }));
    expect(await h.prisma.task.count()).toBe(0);
    expect(writes).toEqual([expect.objectContaining({ model: "project", op: "delete" })]);
  });

  it("warns about nothing with development off", async () => {
    const quiet = trackPrisma(h.prisma, { development: false, logger: h.logger });
    const task = await quiet.task.create({
      data: { projectId, title: "quiet", subtasks: { create: [] } },
    });
    await nextTick();
    expect(task.title).toBe("quiet");
    expect(h.logger.warnings).toEqual([]);
  });
});
