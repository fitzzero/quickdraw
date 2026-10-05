// The operation table of RFC 0003 section 5.2, against PGlite with the real
// generated client: what each write records, what it returns to the caller,
// and how many statements it costs.

import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { storageOf } from "../server/storage";
import { createRecordingSink } from "../testing/recordingSink";
import { createHarness, pauseNext, type Harness } from "./__tests__/harness";
import { trackPrisma } from "./trackPrisma";

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
  h.logger.warnings.length = 0;
  ({ projectId } = await h.seed());
});

function addTask(title: string, data: { status?: string; parentTaskId?: string } = {}) {
  return h.prisma.task.create({ data: { projectId, title, ...data } });
}

describe("create and upsert", () => {
  it("records a create with its id, the fields it set and its interested values", async () => {
    const { value, writes } = await h.inUnit(() =>
      h.db.task.create({ data: { projectId, title: "Plan", status: "open" } }),
    );
    expect(writes).toEqual([
      {
        model: "task",
        id: value.id,
        op: "create",
        fields: ["projectId", "title", "status"],
        after: { projectId, status: "open", parentTaskId: null },
      },
    ]);
  });

  it("adds the id to a select that omits it, and strips it from the result", async () => {
    const { value, writes } = await h.inUnit(() =>
      h.db.task.create({ data: { projectId, title: "No id" }, select: { title: true } }),
    );
    expect(value).toEqual({ title: "No id" });
    const row = await h.prisma.task.findFirstOrThrow({ where: { title: "No id" } });
    expect(writes).toEqual([
      expect.objectContaining({ id: row.id, op: "create", after: expect.any(Object) }),
    ]);
  });

  it("records an upsert that created its row as a create", async () => {
    const { value, writes } = await h.inUnit(() =>
      h.db.task.upsert({
        where: { id: "t-new" },
        create: { id: "t-new", projectId, title: "Created" },
        update: { title: "Updated" },
      }),
    );
    expect(value.title).toBe("Created");
    expect(writes).toEqual([
      expect.objectContaining({ id: "t-new", op: "create", fields: ["id", "projectId", "title"] }),
    ]);
  });

  it("marks an upsert that read nothing as a create whose row may have existed", async () => {
    const existing = await addTask("Existing", { status: "open" });
    const upsert = () =>
      h.db.task.upsert({
        where: { id: existing.id },
        create: { projectId, title: "Never" },
        update: { title: "Updated" },
      });
    const { writes } = await h.inUnit(upsert);
    expect(writes).toEqual([
      expect.objectContaining({ id: existing.id, op: "create", mayHaveExisted: true }),
    ]);
    // So an upsert and a delete in one unit still flush the delete of a row that existed.
    const deleted = await h.inUnit(async () => {
      await upsert();
      await h.db.task.delete({ where: { id: existing.id } });
    });
    expect(deleted.writes).toEqual([
      {
        model: "task",
        id: existing.id,
        op: "delete",
        fields: ["projectId", "title"],
        before: { projectId, status: "open", parentTaskId: null },
      },
    ]);
  });

  it("flushes nothing for a row created and deleted in one unit", async () => {
    const { writes } = await h.inUnit(async () => {
      const task = await h.db.task.create({ data: { projectId, title: "Fleeting" } });
      await h.db.task.delete({ where: { id: task.id } });
    });
    expect(writes).toEqual([]);
  });

  it("reads first when an upsert's update sets an interested column, so an update is an update", async () => {
    const existing = await addTask("Existing", { status: "open" });
    const { writes } = await h.inUnit(() =>
      h.db.task.upsert({
        where: { id: existing.id },
        create: { projectId, title: "Never" },
        update: { status: "done" },
      }),
    );
    expect(writes).toEqual([
      {
        model: "task",
        id: existing.id,
        op: "update",
        fields: ["status"],
        before: { status: "open" },
        after: { projectId, status: "done", parentTaskId: null },
      },
    ]);
  });
});

describe("update and delete", () => {
  it("records an update's fields, with old values only of the interested columns it set", async () => {
    const parent = await addTask("Parent");
    const task = await addTask("Child", { status: "open" });
    const { writes } = await h.inUnit(() =>
      h.db.task.update({
        where: { id: task.id },
        data: { title: "Renamed", status: "done", parentTaskId: parent.id },
      }),
    );
    expect(writes).toEqual([
      {
        model: "task",
        id: task.id,
        op: "update",
        fields: ["title", "status", "parentTaskId"],
        before: { status: "open", parentTaskId: null },
        after: { projectId, status: "done", parentTaskId: parent.id },
      },
    ]);
  });

  it("reads the old values first only when the update sets an interested column", async () => {
    const task = await addTask("Count me", { status: "open" });
    const title = await h.storage.countStatements(() =>
      h.inUnit(() => h.db.task.update({ where: { id: task.id }, data: { title: "Plain" } })),
    );
    const status = await h.storage.countStatements(() =>
      h.inUnit(() => h.db.task.update({ where: { id: task.id }, data: { status: "done" } })),
    );
    expect(title.statements).toBe(1);
    expect(title.value.writes[0]).not.toHaveProperty("before");
    expect(status.statements).toBe(2);
    expect(status.value.writes[0]?.before).toEqual({ status: "open" });
  });

  it("puts a column back that an omit hid, and hides it again", async () => {
    const task = await addTask("Omitted", { status: "open" });
    const { value, writes } = await h.inUnit(() =>
      h.db.task.update({
        where: { id: task.id },
        data: { title: "Still omitted" },
        omit: { projectId: true },
      }),
    );
    expect(value).not.toHaveProperty("projectId");
    expect(writes[0]?.after).toEqual({ projectId, status: "open", parentTaskId: null });
  });

  it("records a delete with the deleted row's interested values, even through a narrow select", async () => {
    const task = await addTask("Doomed", { status: "open" });
    const { value, writes } = await h.inUnit(() =>
      h.db.task.delete({ where: { id: task.id }, select: { title: true } }),
    );
    expect(value).toEqual({ title: "Doomed" });
    expect(writes).toEqual([
      {
        model: "task",
        id: task.id,
        op: "delete",
        fields: [],
        before: { projectId, status: "open", parentTaskId: null },
      },
    ]);
  });
});

describe("the Many operations", () => {
  it("rewrites createMany to createManyAndReturn and records every row, in one statement", async () => {
    const counted = await h.storage.countStatements(() =>
      h.inUnit(() =>
        h.db.task.createMany({
          data: [
            { projectId, title: "a" },
            { projectId, title: "b", status: "done" },
          ],
        }),
      ),
    );
    expect(counted.value.value).toEqual({ count: 2 });
    expect(counted.statements).toBe(1);
    const rows = await h.prisma.task.findMany({ orderBy: { title: "asc" } });
    expect(counted.value.writes.map((write) => [write.id, write.op, write.fields])).toEqual(
      rows.map((row) => [row.id, "create", ["projectId", "title", "status"]]),
    );
  });

  it("rewrites updateMany to updateManyAndReturn, reading old values only when needed", async () => {
    const open = await addTask("open", { status: "open" });
    const done = await addTask("done", { status: "done" });
    const titles = await h.storage.countStatements(() =>
      h.inUnit(() => h.db.task.updateMany({ where: { projectId }, data: { title: "same" } })),
    );
    expect(titles.value.value).toEqual({ count: 2 });
    expect(titles.statements).toBe(1);
    const statuses = await h.storage.countStatements(() =>
      h.inUnit(() => h.db.task.updateMany({ where: { projectId }, data: { status: "late" } })),
    );
    expect(statuses.statements).toBe(2);
    expect(statuses.value.writes).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ id: open.id, op: "update", before: { status: "open" } }),
        expect.objectContaining({ id: done.id, op: "update", before: { status: "done" } }),
      ]),
    );
  });

  it("reads deleteMany's ids and interested values first, with the same where", async () => {
    const a = await addTask("a", { status: "open" });
    const b = await addTask("b", { status: "open" });
    await addTask("kept", { status: "done" });
    const counted = await h.storage.countStatements(() =>
      h.inUnit(() => h.db.task.deleteMany({ where: { status: "open" } })),
    );
    expect(counted.value.value).toEqual({ count: 2 });
    expect(counted.statements).toBe(2);
    expect(counted.value.writes).toEqual(
      expect.arrayContaining([
        {
          model: "task",
          id: a.id,
          op: "delete",
          fields: [],
          before: expect.objectContaining({ status: "open" }),
        },
        {
          model: "task",
          id: b.id,
          op: "delete",
          fields: [],
          before: expect.objectContaining({ status: "open" }),
        },
      ]),
    );
    expect(counted.value.writes).toHaveLength(2);
  });

  it("deletes exactly the rows it read when deleteMany has a limit", async () => {
    await addTask("a");
    await addTask("b");
    await addTask("c");
    const { value, writes } = await h.inUnit(() =>
      h.db.task.deleteMany({ where: { projectId }, limit: 2 }),
    );
    expect(value).toEqual({ count: 2 });
    const left = await h.prisma.task.findMany({ select: { id: true } });
    expect(left).toHaveLength(1);
    expect(writes.map((write) => write.id)).not.toContain(left[0]?.id);
    expect(writes).toHaveLength(2);
  });

  it("strips the added id from createManyAndReturn and updateManyAndReturn results", async () => {
    const created = await h.inUnit(() =>
      h.db.task.createManyAndReturn({ data: [{ projectId, title: "x" }], select: { title: true } }),
    );
    expect(created.value).toEqual([{ title: "x" }]);
    expect(created.writes).toEqual([expect.objectContaining({ op: "create" })]);
    const updated = await h.inUnit(() =>
      h.db.task.updateManyAndReturn({
        where: { projectId },
        data: { title: "y" },
        select: { title: true },
      }),
    );
    expect(updated.value).toEqual([{ title: "y" }]);
    expect(updated.writes).toEqual([
      expect.objectContaining({ id: created.writes[0]?.id, op: "update", fields: ["title"] }),
    ]);
  });
});

describe("writes that change nothing (finding F7.2)", () => {
  async function addMember(role: string) {
    const user = await h.prisma.user.create({
      data: { email: `${crypto.randomUUID()}@example.com`, name: "Bo" },
    });
    return h.prisma.projectMember.create({ data: { projectId, userId: user.id, role } });
  }

  it("records nothing for an upsert with an empty update that finds its row, in one statement", async () => {
    const member = await addMember("Read");
    const ensure = (select?: { readonly role: true }) =>
      h.db.projectMember.upsert({
        where: { projectId_userId: { projectId, userId: member.userId } },
        update: {},
        create: { projectId, userId: member.userId, role: "Moderate" },
        ...(select === undefined ? {} : { select }),
      });
    const counted = await h.storage.countStatements(() => h.inUnit(() => ensure()));
    expect(counted.value.writes).toEqual([]);
    expect(counted.statements).toBe(1);
    // It answers what the upsert answers: the row as it is, through the caller's selection.
    expect(counted.value.value).toEqual(member);
    expect((await h.inUnit(() => ensure({ role: true }))).value).toEqual({ role: "Read" });
    const undefinedOnly = await h.inUnit(() =>
      h.db.projectMember.upsert({
        where: { projectId_userId: { projectId, userId: member.userId } },
        update: { role: undefined },
        create: { projectId, userId: member.userId, role: "Moderate" },
      }),
    );
    expect(undefinedOnly.writes).toEqual([]);
  });

  it("records a create for an upsert with an empty update that creates its row, in two statements", async () => {
    const user = await h.prisma.user.create({ data: { email: "new@example.com", name: "Cy" } });
    const counted = await h.storage.countStatements(() =>
      h.inUnit(() =>
        h.db.projectMember.upsert({
          where: { projectId_userId: { projectId, userId: user.id } },
          update: {},
          create: { projectId, userId: user.id, role: "Read" },
          select: { role: true },
        }),
      ),
    );
    expect(counted.value.value).toEqual({ role: "Read" });
    expect(counted.statements).toBe(2);
    const row = await h.prisma.projectMember.findFirstOrThrow({ where: { userId: user.id } });
    expect(counted.value.writes).toEqual([
      {
        model: "projectMember",
        id: row.id,
        op: "create",
        fields: ["projectId", "userId", "role"],
        after: { projectId, userId: user.id, role: "Read" },
        mayHaveExisted: true,
      },
    ]);
  });

  it("records an update or upsert that sets interested columns to what they held, as any write", async () => {
    const member = await addMember("Read");
    const task = await addTask("Same", { status: "open" });
    const same = await h.inUnit(async () => {
      await h.db.task.update({ where: { id: task.id }, data: { status: "open" } });
      await h.db.projectMember.upsert({
        where: { projectId_userId: { projectId, userId: member.userId } },
        update: { role: "Read" },
        create: { projectId, userId: member.userId, role: "Read" },
      });
      await h.db.task.update({ where: { id: task.id }, data: {} });
    });
    // The read made before a write is not atomic with it, so equal values prove nothing.
    expect(same.writes).toEqual([
      expect.objectContaining({ model: "task", id: task.id, op: "update", fields: ["status"] }),
      expect.objectContaining({ model: "projectMember", id: member.id, op: "update" }),
    ]);
  });

  it("answers an update with nothing to write as Prisma does, and records nothing", async () => {
    const task = await addTask("Empty");
    const { value, writes } = await h.inUnit(() =>
      h.db.task.update({ where: { id: task.id }, data: { title: undefined } }),
    );
    expect(value).toEqual(task);
    expect(writes).toEqual([]);
    await expect(
      h.inUnit(() => h.db.task.update({ where: { id: "missing" }, data: {} })),
    ).rejects.toMatchObject({ code: "P2025" });
  });

  it("records nothing for the Many operations when they match no row or write nothing", async () => {
    const open = await addTask("open", { status: "open" });
    const done = await addTask("done", { status: "done" });
    const none = await h.inUnit(async () => {
      expect(
        await h.db.task.updateMany({ where: { status: "missing" }, data: { status: "x" } }),
      ).toEqual({ count: 0 });
      expect(await h.db.task.deleteMany({ where: { status: "missing" } })).toEqual({ count: 0 });
      expect(
        await h.db.task.updateManyAndReturn({ where: { status: "missing" }, data: { title: "y" } }),
      ).toEqual([]);
      // Prisma writes nothing and answers 0, through the tracked client too.
      expect(await h.db.task.updateMany({ where: { projectId }, data: {} })).toEqual({ count: 0 });
      expect(await h.db.task.updateManyAndReturn({ where: { projectId }, data: {} })).toHaveLength(
        2,
      );
    });
    expect(none.writes).toEqual([]);
    // Every row it matched records its update, a row that already held the value too.
    const some = await h.inUnit(() =>
      h.db.task.updateMany({ where: { projectId }, data: { status: "done" } }),
    );
    expect(some.writes).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ id: open.id, op: "update", before: { status: "open" } }),
        expect.objectContaining({ id: done.id, op: "update", before: { status: "done" } }),
      ]),
    );
    expect(some.writes).toHaveLength(2);
  });

  it("records the last of a batch's writes that sets a column back to what it held before the batch", async () => {
    const task = await addTask("Batched", { status: "open" });
    const { writes } = await h.inUnit(() =>
      h.db.$transaction([
        h.db.task.update({ where: { id: task.id }, data: { status: "done" } }),
        h.db.task.update({ where: { id: task.id }, data: { status: "open" } }),
      ]),
    );
    const row = await h.prisma.task.findUniqueOrThrow({ where: { id: task.id } });
    expect(row.status).toBe("open");
    // Both reads ran before the batch; the merged record ends where the database does.
    expect(writes).toEqual([
      expect.objectContaining({
        id: task.id,
        op: "update",
        before: { status: "open" },
        after: expect.objectContaining({ status: "open" }),
      }),
    ]);
  });

  it("records a write whose stale read saw the value it sets, after another write changed it", async () => {
    const task = await addTask("Raced", { status: "open" });
    const pause = pauseNext(h.database, /^\s*UPDATE\s+"public"\."Task"/iu);
    try {
      // The first unit reads "open", and its UPDATE waits while the second runs whole.
      const reEnsure = h.inUnit(() =>
        h.db.task.update({ where: { id: task.id }, data: { status: "open" } }),
      );
      await pause.reached;
      const change = await h.inUnit(() =>
        h.db.task.update({ where: { id: task.id }, data: { status: "done" } }),
      );
      pause.release();
      const { writes } = await reEnsure;
      expect(change.writes).toEqual([
        expect.objectContaining({ id: task.id, before: { status: "open" } }),
      ]);
      expect((await h.prisma.task.findUniqueOrThrow({ where: { id: task.id } })).status).toBe(
        "open",
      );
      // Its real change, done to open, is recorded and flushed.
      expect(writes).toEqual([
        expect.objectContaining({
          id: task.id,
          op: "update",
          fields: ["status"],
          after: expect.objectContaining({ status: "open" }),
        }),
      ]);
    } finally {
      pause.restore();
    }
  });

  it("records nothing for an updateMany in a batch that answers count 0", async () => {
    await addTask("a", { status: "open" });
    const { writes } = await h.inUnit(() =>
      h.db.$transaction([
        h.db.task.updateMany({ where: { status: "missing" }, data: { status: "done" } }),
        h.db.task.updateMany({ where: { projectId }, data: {} }),
      ]),
    );
    expect(writes).toEqual([]);
  });
});

describe("models and registrations", () => {
  it("lets writes to a model without an id column through, untracked, with one warning", async () => {
    const expires = new Date("2030-01-01T00:00:00Z");
    const { value, writes } = await h.inUnit(async () => {
      await h.db.verificationToken.deleteMany({ where: { identifier: "nobody" } });
      await h.db.verificationToken.create({
        data: { identifier: "a@b.c", token: "t", expires },
        select: { token: true },
      });
      return h.db.verificationToken.deleteMany({ where: { identifier: "a@b.c" } });
    });
    expect(value).toEqual({ count: 1 });
    expect(writes).toEqual([]);
    expect(h.logger.warnings).toEqual([
      expect.stringContaining("Writes to verificationToken are not tracked"),
    ]);
  });

  it("stops tracking a model without an id column, whichever write finds out first", async () => {
    const expires = new Date("2030-01-01T00:00:00Z");
    const firstWrites = [
      (db: typeof h.db) =>
        db.verificationToken.createMany({ data: [{ identifier: "a", token: "1", expires }] }),
      (db: typeof h.db) =>
        db.verificationToken.updateMany({ where: { identifier: "a" }, data: { expires } }),
      (db: typeof h.db) =>
        db.verificationToken.create({
          data: { identifier: "b", token: "2", expires },
          select: { token: true },
        }),
      (db: typeof h.db) => db.verificationToken.deleteMany({ where: { identifier: "b" } }),
    ];
    for (const first of firstWrites) {
      const db = trackPrisma(h.prisma, { logger: h.logger, development: false });
      const writes: unknown[] = [];
      storageOf(db)?.onWrite((write) => writes.push(write));
      await expect(first(db)).resolves.toBeDefined();
      expect(writes).toEqual([]);
    }
    expect(h.logger.warnings).toHaveLength(firstWrites.length);
    expect(await h.prisma.verificationToken.count()).toBe(1);
  });

  it("leaves a caller's invalid arguments to fail as theirs, and keeps tracking the model", async () => {
    const task = await addTask("Valid");
    await expect(
      h.inUnit(() => h.db.task.deleteMany({ where: { nope: true } as never })),
    ).rejects.toThrow("Unknown argument");
    await expect(
      h.inUnit(() => h.db.task.createMany({ data: [{ projectId, nope: 1 } as never] })),
    ).rejects.toThrow();
    const { writes } = await h.inUnit(() =>
      h.db.task.update({ where: { id: task.id }, data: { title: "Tracked" } }),
    );
    expect(writes).toEqual([expect.objectContaining({ id: task.id, op: "update" })]);
    expect(h.logger.warnings).toEqual([]);
  });

  it("refuses to track a client twice, or anything that is not a client", () => {
    expect(() => trackPrisma(h.db)).toThrow("tracked already");
    expect(() => trackPrisma({} as never)).toThrow("must be a Prisma client");
  });

  it("records interested values a later registration adds, for the model in either spelling", async () => {
    const tracked = trackPrisma(h.prisma, { development: false });
    const storage = storageOf(tracked);
    if (storage === undefined) {
      throw new Error("no storage adapter");
    }
    storage.registerInterest("Project", ["ownerId", "id"]);
    expect(storage.interestOf("project")).toEqual(["ownerId"]);
    expect(() => storage.registerInterest("", ["x"])).toThrow(TypeError);
    const sink = createRecordingSink();
    const unit = storage.unitOfWork.begin({ requestId: "r", transport: "internal", sink });
    await unit.run(() => tracked.project.update({ where: { id: projectId }, data: { name: "x" } }));
    await unit.flush();
    expect(sink.writes()).toEqual([
      {
        model: "project",
        id: projectId,
        op: "update",
        fields: ["name"],
        after: { ownerId: expect.any(String) },
      },
    ]);
  });

  it("reads through the storage adapter with Prisma's argument shapes", async () => {
    await addTask("b", { status: "open" });
    await addTask("a", { status: "done" });
    await expect(
      h.storage.findMany("task", {
        where: { projectId },
        select: { title: true },
        orderBy: [{ title: "asc" }],
        take: 1,
      }),
    ).resolves.toEqual([{ title: "a" }]);
    await expect(h.storage.count("Task", { where: { status: "open" } })).resolves.toBe(1);
    await expect(h.storage.findMany("nothing")).rejects.toThrow('no model "nothing"');
  });
});
