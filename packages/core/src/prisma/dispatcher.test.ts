// Tracked writes through the method pipeline (RFC 0003 sections 5.1, 5.3
// and 9): a dispatcher created with a tracked client runs every handler in a
// unit of work and flushes it after the response, `ctx.touch` records what
// the client cannot see, and `qd.run` gives jobs the same.

import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { z } from "zod";
import type { PrismaClient } from "../../test/prisma/setup";
import { defineContract, mutation, query } from "../index";
import { createDispatcher, initQuickdraw, type CallRecord, type Principal } from "../server/index";
import { storageOf } from "../server/storage";
import { createTestApp } from "../testing/createTestApp";
import { createRecordingSink, type RecordingSink } from "../testing/recordingSink";
import { createHarness, nextTick, type Harness } from "./__tests__/harness";

const row = z.object({ id: z.string(), title: z.string() });

const taskContract = defineContract("taskService", {
  methods: {
    rename: mutation({ input: z.object({ id: z.string(), title: z.string() }), output: row }),
    renameThenFail: mutation({ input: z.object({ id: z.string() }), output: z.null() }),
    retitleBySql: mutation({
      input: z.object({ id: z.string(), title: z.string(), rollBack: z.boolean() }),
      output: z.number(),
    }),
    renameInJob: mutation({ input: z.object({ id: z.string() }), output: z.null() }),
    renameLater: mutation({ input: z.object({ id: z.string() }), output: z.null() }),
    touchContract: mutation({ input: z.object({ id: z.string() }), output: z.null() }),
    count: query({ input: z.object({}), output: z.number() }),
  },
});

const qd = initQuickdraw<{ db: PrismaClient; principal: Principal }>();
const alice: Principal = { userId: "alice" };

/** What `renameLater` started, and the gate it waits behind. */
let background: Promise<unknown> = Promise.resolve();
let gate: Promise<void> = Promise.resolve();

const taskService = qd.defineService(taskContract, {
  model: "task",
  methods: {
    rename: {
      access: "authenticated",
      // Returned without awaiting: the unit of work awaits it in its scope.
      handler: ({ input, db }) =>
        db.task.update({ where: { id: input.id }, data: { title: input.title } }),
    },
    renameThenFail: {
      access: "authenticated",
      handler: async ({ input, db }) => {
        await db.task.update({ where: { id: input.id }, data: { title: "written" } });
        throw new Error("after the write");
      },
    },
    retitleBySql: {
      access: "authenticated",
      handler: ({ input, db, ctx }) =>
        db.$transaction(async (tx) => {
          const changed =
            await tx.$executeRaw`UPDATE "Task" SET "title" = ${input.title} WHERE "id" = ${input.id}`;
          ctx.touch("task", input.id);
          if (input.rollBack) {
            throw new Error("rolled back");
          }
          return changed;
        }),
    },
    renameInJob: {
      access: "authenticated",
      handler: async ({ input, db }) => {
        await qd.run(() => db.task.update({ where: { id: input.id }, data: { title: "job" } }));
        return null;
      },
    },
    renameLater: {
      access: "authenticated",
      handler: ({ input, db }) => {
        // Background work the reply does not wait for: it writes after the call's unit flushed.
        background = qd.run(
          async () => {
            await gate;
            await db.task.update({ where: { id: input.id }, data: { title: "later" } });
          },
          { detached: true },
        );
        return null;
      },
    },
    touchContract: {
      access: "authenticated",
      handler: ({ input, ctx }) => {
        ctx.touch(taskContract, input.id);
        return null;
      },
    },
    count: { access: "public", handler: ({ db }) => db.task.count() },
  },
});

let h: Harness;
let taskId: string;
let sink: RecordingSink;

beforeAll(async () => {
  h = await createHarness();
}, 60_000);

afterAll(async () => {
  await h.close();
});

beforeEach(async () => {
  await h.database.reset();
  const { projectId } = await h.seed();
  taskId = (await h.prisma.task.create({ data: { projectId, title: "Plan" } })).id;
  sink = createRecordingSink();
});

function dispatcherWith(onCall?: (record: CallRecord) => void) {
  return qd.createDispatcher({
    services: [taskService],
    db: h.db,
    flushSink: sink,
    logger: h.logger,
    onCall,
  });
}

describe("a call's unit of work", () => {
  it("flushes after the response is produced, then emits the completion record", async () => {
    const events: string[] = [];
    const ordered = qd.createDispatcher({
      services: [taskService],
      db: h.db,
      flushSink: {
        flush: (writes, info) => {
          events.push("flush");
          return sink.flush(writes, info);
        },
      },
      logger: h.logger,
      onCall: (record) => events.push(`record:${record.sqlStatements}`),
    });
    const result = await ordered.call({
      service: "taskService",
      method: "rename",
      input: { id: taskId, title: "Renamed" },
      principal: alice,
      transport: "socket",
      requestId: "req-1",
      respond: () => {
        events.push("respond");
        return 1;
      },
    });
    expect(result).toMatchObject({ ok: true, data: { id: taskId, title: "Renamed" } });
    expect(events).toEqual(["respond", "flush", "record:1"]);
    expect(sink.flushes).toEqual([
      {
        writes: [
          { model: "task", id: taskId, op: "update", fields: ["title"], after: expect.any(Object) },
        ],
        info: {
          service: "taskService",
          method: "rename",
          kind: "mutation",
          requestId: "req-1",
          transport: "socket",
          rev: expect.any(Number),
        },
      },
    ]);
  });

  it("tracks the Prisma promise a handler returns without awaiting it", async () => {
    const dispatcher = dispatcherWith();
    await dispatcher.caller(alice).taskService.rename({ id: taskId, title: "Lazy" });
    expect(sink.writes()).toEqual([expect.objectContaining({ id: taskId, op: "update" })]);
  });

  it("flushes the writes of a handler that throws after writing", async () => {
    const dispatcher = dispatcherWith();
    await expect(
      dispatcher.caller(alice).taskService.renameThenFail({ id: taskId }),
    ).rejects.toThrow("Internal error");
    expect(sink.writes()).toEqual([expect.objectContaining({ id: taskId, fields: ["title"] })]);
  });

  it("flushes nothing for a call that wrote nothing", async () => {
    const dispatcher = dispatcherWith();
    await expect(dispatcher.caller(alice).taskService.count({})).resolves.toBe(1);
    expect(sink.flushes).toEqual([]);
  });
});

describe("ctx.touch", () => {
  it("records a raw SQL write into the open transaction, and a rollback drops it", async () => {
    const dispatcher = dispatcherWith();
    const caller = dispatcher.caller(alice).taskService;
    await expect(
      caller.retitleBySql({ id: taskId, title: "dropped", rollBack: true }),
    ).rejects.toThrow();
    expect(sink.flushes).toEqual([]);
    await expect(caller.retitleBySql({ id: taskId, title: "SQL", rollBack: false })).resolves.toBe(
      1,
    );
    expect(sink.writes()).toEqual([{ model: "task", id: taskId, op: "update", fields: ["*"] }]);
  });

  it("resolves a contract to the model its service declares", async () => {
    const dispatcher = dispatcherWith();
    await dispatcher.caller(alice).taskService.touchContract({ id: taskId });
    expect(sink.writes()).toEqual([{ model: "task", id: taskId, op: "update", fields: ["*"] }]);
  });

  it("refuses a contract whose service declares no database model", async () => {
    const labelContract = defineContract("labelService", {
      methods: { touch: mutation({ input: z.object({ id: z.string() }), output: z.null() }) },
    });
    const labelService = qd.defineService(labelContract, {
      methods: {
        touch: {
          access: "authenticated",
          handler: ({ input, ctx }) => {
            ctx.touch(labelContract, input.id);
            return null;
          },
        },
      },
    });
    const dispatcher = qd.createDispatcher({
      services: [taskService, labelService],
      db: h.db,
      flushSink: sink,
      logger: h.logger,
    });
    await expect(dispatcher.caller(alice).labelService.touch({ id: "l1" })).rejects.toThrow(
      "no service of this dispatcher declares the database model of labelService",
    );
    expect(sink.flushes).toEqual([]);
  });
});

describe("qd.run and writes outside methods", () => {
  it("flushes a job's writes before run returns, and a failed job's too", async () => {
    dispatcherWith();
    await qd.run(() => h.db.task.update({ where: { id: taskId }, data: { title: "job" } }));
    expect(sink.flushes).toEqual([
      {
        writes: [expect.objectContaining({ id: taskId, op: "update" })],
        info: { requestId: expect.any(String), transport: "internal", rev: expect.any(Number) },
      },
    ]);
    await expect(
      qd.run(async () => {
        await h.db.task.update({ where: { id: taskId }, data: { title: "again" } });
        throw new Error("job failed");
      }),
    ).rejects.toThrow("job failed");
    expect(sink.flushes).toHaveLength(2);
  });

  it("joins the call's unit when a handler uses qd.run", async () => {
    const dispatcher = dispatcherWith();
    await dispatcher.caller(alice).taskService.renameInJob({ id: taskId });
    expect(sink.flushes).toHaveLength(1);
    expect(sink.flushes[0]?.info.method).toBe("renameInJob");
  });

  it("runs a handler's detached background work in a unit of its own, flushed when it settles", async () => {
    const records: CallRecord[] = [];
    const dispatcher = dispatcherWith((record) => records.push(record));
    const warned = h.logger.warnings.length;
    let open = (): void => undefined;
    gate = new Promise((resolve) => {
      open = resolve;
    });
    await dispatcher.caller(alice).taskService.renameLater({ id: taskId });
    // The call flushed (nothing written in it) and answered before its background work wrote.
    expect(sink.flushes).toEqual([]);
    expect(records.map((record) => record.sqlStatements)).toEqual([0]);
    open();
    await background;
    expect(sink.flushes).toEqual([
      {
        writes: [expect.objectContaining({ id: taskId, op: "update" })],
        info: { requestId: expect.any(String), transport: "internal", rev: expect.any(Number) },
      },
    ]);
    // Flushed in its unit, not on the next tick as an ambient write: no warning.
    expect(h.logger.warnings.slice(warned)).toEqual([]);
  });

  it("checks run's options", async () => {
    dispatcherWith();
    await expect(qd.run(() => 1, { detached: "yes" as unknown as boolean })).rejects.toThrow(
      "detached must be true or false",
    );
    await expect(qd.run(() => 1, 3 as unknown as { detached?: boolean })).rejects.toThrow(
      "options must be an object",
    );
    expect(await qd.run(() => 2, { detached: true })).toBe(2);
  });

  it("gives a job { touch, log, principal: null }, so it records a raw SQL write", async () => {
    dispatcherWith();
    let seen: unknown;
    const changed = await qd.run(async (ctx) => {
      seen = ctx;
      const count = await h.db
        .$executeRaw`UPDATE "Task" SET "title" = 'by sql' WHERE "id" = ${taskId}`;
      ctx.touch("task", [taskId]);
      ctx.log.debug("retitled by SQL", { taskId });
      return count;
    });
    expect(changed).toBe(1);
    expect(seen).toEqual({
      touch: expect.any(Function),
      log: expect.objectContaining({ debug: expect.any(Function) }),
      principal: null,
    });
    expect(Object.isFrozen(seen)).toBe(true);
    // The raw write is invisible to the tracked client; the touch is all the flush has.
    expect(sink.flushes).toEqual([
      {
        writes: [{ model: "task", id: taskId, op: "update", fields: ["*"] }],
        info: { requestId: expect.any(String), transport: "internal", rev: expect.any(Number) },
      },
    ]);
    // A job that takes no parameter still runs.
    expect(await qd.run(() => "no context needed")).toBe("no context needed");
  });

  it("flushes a write made outside any unit to the dispatcher created last", async () => {
    dispatcherWith();
    await h.db.task.update({ where: { id: taskId }, data: { title: "ambient" } });
    await nextTick();
    expect(sink.writes()).toEqual([expect.objectContaining({ id: taskId, op: "update" })]);
  });

  it("fails qd.run on an app that has created no dispatcher", async () => {
    const lone = initQuickdraw();
    await expect(lone.run(() => 1)).rejects.toThrow("qd.run has no dispatcher to flush through");
  });
});

describe("wiring", () => {
  it("finds the storage adapter on the tracked client, and fans a flush out to every sink", async () => {
    const second = createRecordingSink();
    const dispatcher = createDispatcher({
      services: [taskService],
      db: h.db,
      flushSink: [sink, second],
      logger: h.logger,
    });
    expect(storageOf(h.db)).toBeDefined();
    expect(storageOf(h.prisma)).toBeUndefined();
    await dispatcher.caller(alice).taskService.rename({ id: taskId, title: "Both" });
    expect(sink.writes()).toHaveLength(1);
    expect(second.writes()).toEqual(sink.writes());
  });

  it("serves tracked writes through createServer, given the tracked client as db", async () => {
    const app = await createTestApp({
      services: [taskService],
      db: h.db,
      flushSink: sink,
      logger: h.logger,
    });
    try {
      const { call, close } = await app.connect(alice);
      await call.taskService.rename({ id: taskId, title: "Over a socket" });
      close();
      const flushed = await sink.next();
      expect(flushed.info).toMatchObject({ service: "taskService", transport: "socket" });
      expect(flushed.writes).toEqual([expect.objectContaining({ id: taskId, op: "update" })]);
    } finally {
      await app.close();
    }
  });
});
