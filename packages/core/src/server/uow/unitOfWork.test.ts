import { describe, expect, it } from "vitest";
import type { Logger } from "../../contract/logger";
import { createRecordingSink } from "../../testing/recordingSink";
import type { FlushSink } from "./flushSink";
import { ANY_FIELD, type UnitOfWorkScope, type WriteRecord } from "./types";
import { createWriteTracker, type WriteTracker } from "./unitOfWork";

function captureLogger(): Logger & { readonly warnings: string[] } {
  const warnings: string[] = [];
  const ignore = (): void => undefined;
  const logger = {
    warnings,
    debug: ignore,
    info: ignore,
    error: ignore,
    warn: (message: string): void => {
      warnings.push(message);
    },
    child: () => logger,
  };
  return logger;
}

const write = (id: string, op: WriteRecord["op"] = "update"): WriteRecord => ({
  model: "task",
  id,
  op,
  fields: op === "update" ? ["title"] : [],
});

const scope = (sink: FlushSink): UnitOfWorkScope => ({
  service: "taskService",
  method: "rename",
  kind: "mutation",
  requestId: "req-1",
  transport: "socket",
  sink,
});

const nextTick = (): Promise<void> =>
  new Promise((resolve) => {
    setImmediate(resolve);
  });

/** Like a Prisma promise: it records its write only when something awaits it. */
function lazyWrite(tracker: WriteTracker, id: string): PromiseLike<string> {
  return {
    then(onfulfilled, onrejected) {
      tracker.record([write(id)]);
      return Promise.resolve(id).then(onfulfilled, onrejected);
    },
  };
}

describe("a tracked unit of work", () => {
  it("awaits a lazy result inside its scope, so the write is the unit's", async () => {
    const tracker = createWriteTracker({ development: false });
    const sink = createRecordingSink();
    const unit = tracker.unitOfWork.begin(scope(sink));
    expect(await unit.run(() => lazyWrite(tracker, "t1"))).toBe("t1");
    await unit.flush();
    expect(sink.writes()).toEqual([write("t1")]);
  });

  it("misses a lazy write created inside the scope but awaited outside it", async () => {
    const tracker = createWriteTracker({ development: false });
    const unitSink = createRecordingSink();
    const ambientSink = createRecordingSink();
    tracker.unitOfWork.attach?.(ambientSink, captureLogger());
    const unit = tracker.unitOfWork.begin(scope(unitSink));
    let escaped: PromiseLike<string> | undefined;
    await unit.run(() => {
      escaped = lazyWrite(tracker, "t1");
      return 0;
    });
    await escaped;
    await unit.flush();
    expect(unitSink.flushes).toEqual([]);
    expect((await ambientSink.next()).writes).toEqual([write("t1")]);
  });

  it("flushes once, after the run, with the call's scope and a revision", async () => {
    const tracker = createWriteTracker({ development: false });
    const sink = createRecordingSink();
    const unit = tracker.unitOfWork.begin(scope(sink));
    await unit.run(() => {
      tracker.record([write("t1"), write("t2")]);
      tracker.record([write("t1")]);
    });
    expect(sink.flushes).toEqual([]);
    await unit.flush();
    await unit.flush();
    expect(sink.flushes).toEqual([
      {
        writes: [write("t1"), write("t2")],
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

  it("flushes the writes of a run that threw", async () => {
    const tracker = createWriteTracker({ development: false });
    const sink = createRecordingSink();
    const unit = tracker.unitOfWork.begin(scope(sink));
    await expect(
      unit.run(() => {
        tracker.record([write("t1")]);
        throw new Error("after the write");
      }),
    ).rejects.toThrow("after the write");
    await unit.flush();
    expect(sink.writes()).toEqual([write("t1")]);
  });

  it("joins a committed transaction's writes and drops a rolled-back one's", async () => {
    const tracker = createWriteTracker({ development: false });
    const sink = createRecordingSink();
    const unit = tracker.unitOfWork.begin(scope(sink));
    const seen: unknown[] = [];
    await unit.run(async () => {
      const committed = tracker.openTransaction("interactive");
      committed.setClient("tx-1");
      await committed.run(() => {
        seen.push(tracker.transactionClient());
        tracker.record([write("t1", "create")]);
      });
      committed.commit();
      const rolledBack = tracker.openTransaction("interactive");
      await rolledBack.run(() => tracker.record([write("t2", "create")]));
      rolledBack.rollback();
      seen.push(tracker.transactionClient());
    });
    await unit.flush();
    expect(seen).toEqual(["tx-1", undefined]);
    expect(sink.writes()).toEqual([write("t1", "create")]);
  });

  it("knows an array-form transaction from an interactive one", async () => {
    const tracker = createWriteTracker({ development: false });
    const batch = tracker.openTransaction("batch");
    const interactive = tracker.openTransaction("interactive");
    expect(await batch.run(() => tracker.inBatch())).toBe(true);
    expect(await interactive.run(() => tracker.inBatch())).toBe(false);
    expect(tracker.inBatch()).toBe(false);
  });

  it("joins a unit begun inside another, so the outer one flushes both", async () => {
    const tracker = createWriteTracker({ development: false });
    const sink = createRecordingSink();
    const outer = tracker.unitOfWork.begin(scope(sink));
    const inner = tracker.unitOfWork.begin(scope(sink));
    await outer.run(async () => {
      tracker.countStatement();
      await inner.run(() => {
        tracker.countStatement();
        tracker.record([write("t1")]);
      });
      await inner.flush();
      expect(sink.flushes).toEqual([]);
    });
    await outer.flush();
    expect(sink.writes()).toEqual([write("t1")]);
    expect(outer.sqlStatements).toBe(2);
    expect(inner.sqlStatements).toBe(1);
  });

  it("records touches where they run, as changes of any field or as deletes", async () => {
    const tracker = createWriteTracker({ development: false });
    const sink = createRecordingSink();
    const unit = tracker.unitOfWork.begin(scope(sink));
    await unit.run(async () => {
      tracker.unitOfWork.touch?.("task", ["t1", "t1", "t2"]);
      const rolledBack = tracker.openTransaction("interactive");
      await rolledBack.run(() => tracker.unitOfWork.touch?.("task", ["t3"]));
      rolledBack.rollback();
      tracker.touch("label", ["l1"], { removed: true });
    });
    await unit.flush();
    expect(sink.writes()).toEqual([
      { model: "task", id: "t1", op: "update", fields: [ANY_FIELD] },
      { model: "task", id: "t2", op: "update", fields: [ANY_FIELD] },
      { model: "label", id: "l1", op: "delete", fields: [] },
    ]);
  });
});

describe("writes outside any unit of work", () => {
  it("flush together on the next tick, to the attached sink, with one warning per model", async () => {
    const tracker = createWriteTracker({ development: true });
    const sink = createRecordingSink();
    const logger = captureLogger();
    tracker.unitOfWork.attach?.(sink, logger);
    tracker.record([write("t1")]);
    tracker.record([write("t2"), write("t1", "delete")]);
    tracker.record([{ model: "label", id: "l1", op: "create", fields: [] }]);
    expect(sink.flushes).toEqual([]);
    await nextTick();
    expect(sink.flushes).toHaveLength(1);
    expect(sink.flushes[0]?.info).toEqual({
      requestId: expect.any(String),
      transport: "internal",
      rev: expect.any(Number),
    });
    expect(sink.writes().map((ambient) => `${ambient.op} ${ambient.id}`)).toEqual([
      "delete t1",
      "update t2",
      "create l1",
    ]);
    expect(logger.warnings).toEqual([
      expect.stringContaining("A tracked write to task ran outside any unit of work"),
      expect.stringContaining("A tracked write to label ran outside any unit of work"),
    ]);
  });

  it("include a unit's late writes, made after it flushed", async () => {
    const tracker = createWriteTracker({ development: false });
    const unitSink = createRecordingSink();
    const ambientSink = createRecordingSink();
    tracker.unitOfWork.attach?.(ambientSink, captureLogger());
    const unit = tracker.unitOfWork.begin(scope(unitSink));
    let late: (() => void) | undefined;
    await unit.run(() => {
      late = () => tracker.record([write("t9")]);
    });
    await unit.flush();
    late?.();
    expect((await ambientSink.next()).writes).toEqual([write("t9")]);
    expect(unitSink.flushes).toEqual([]);
  });

  it("warn nothing outside development", async () => {
    const tracker = createWriteTracker({ development: false });
    const logger = captureLogger();
    tracker.unitOfWork.attach?.(createRecordingSink(), logger);
    tracker.record([write("t1")]);
    tracker.warnOnce("key", "a warning");
    await nextTick();
    expect(logger.warnings).toEqual([]);
  });
});

describe("statement counts and write listeners", () => {
  it("count the statements of nested frames into each of them", async () => {
    const tracker = createWriteTracker({ development: false });
    const counted = await tracker.countStatements(async () => {
      tracker.countStatement();
      const inner = await tracker.countStatements(() => {
        tracker.countStatement();
        tracker.countStatement();
        return "inner";
      });
      return inner;
    });
    expect(counted).toEqual({ value: { value: "inner", statements: 2 }, statements: 3 });
  });

  it("hear writes once they are durable, never a rolled-back one", async () => {
    const tracker = createWriteTracker({ development: false });
    tracker.unitOfWork.attach?.(createRecordingSink(), captureLogger());
    const heard: string[] = [];
    const stop = tracker.onWrite((heardWrite) => heard.push(heardWrite.id));
    const unit = tracker.unitOfWork.begin(scope(createRecordingSink()));
    await unit.run(async () => {
      tracker.record([write("t1")]);
      const committed = tracker.openTransaction("interactive");
      await committed.run(() => tracker.record([write("t2")]));
      expect(heard).toEqual(["t1"]);
      committed.commit();
      const rolledBack = tracker.openTransaction("interactive");
      await rolledBack.run(() => tracker.record([write("t3")]));
      rolledBack.rollback();
    });
    tracker.record([write("t4")]);
    stop();
    tracker.record([write("t5")]);
    expect(heard).toEqual(["t1", "t2", "t4"]);
  });
});
