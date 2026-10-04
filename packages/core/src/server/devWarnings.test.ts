// The shared development warning format (`devWarnings.ts`): one line per
// warning naming its kind and call, once per kind, service, method and
// subject; thrown instead when strict; off in production. And the loop
// watch's `repeated-call` warnings, through a dispatcher and on their own.

import { describe, expect, it } from "vitest";
import { captureLogger, deferred, qd, setup, task, taskDefaults } from "./__tests__/fixtures";
import {
  checked,
  createDevWarnings,
  createLoopWatch,
  DevWarningError,
  formatDevWarning,
  isQuiet,
  quietly,
  REFUSAL_WINDOW_MS,
  REPEATED_CALL_WINDOW_MS,
  STRICT_WARNINGS,
  type DevWarning,
} from "./devWarnings";

const nPlusOne: DevWarning = {
  kind: "n-plus-one",
  service: "taskService",
  method: "board",
  message: "task.findUnique by id ran 10 times in one call",
  meta: { model: "task" },
};

describe("development warnings", () => {
  it("share one format, naming the kind and the call when there is one", () => {
    expect(formatDevWarning(nPlusOne)).toBe(
      "[quickdraw:n-plus-one] taskService.board: task.findUnique by id ran 10 times in one call",
    );
    expect(
      formatDevWarning({ kind: "ambient-write", subject: "task", message: "outside any unit" }),
    ).toBe("[quickdraw:ambient-write] outside any unit");
  });

  it("are logged once per kind, service, method and subject, with their call in the meta", () => {
    const logger = captureLogger();
    const warnings = createDevWarnings({ logger, development: true });
    warnings.warn(nPlusOne);
    warnings.warn(nPlusOne);
    warnings.warn({ ...nPlusOne, method: "list" });
    warnings.warn({ ...nPlusOne, kind: "unbounded-read" });
    warnings.warn({ kind: "nested-write", subject: "task.labels.create", message: "nested" });
    warnings.warn({ kind: "nested-write", subject: "task.labels.create", message: "nested" });
    warnings.warn({ kind: "nested-write", subject: "task.subtasks.create", message: "nested" });
    expect(logger.at("warn").map((entry) => entry.message)).toEqual([
      "[quickdraw:n-plus-one] taskService.board: task.findUnique by id ran 10 times in one call",
      "[quickdraw:n-plus-one] taskService.list: task.findUnique by id ran 10 times in one call",
      "[quickdraw:unbounded-read] taskService.board: task.findUnique by id ran 10 times in one call",
      "[quickdraw:nested-write] nested",
      "[quickdraw:nested-write] nested",
    ]);
    expect(logger.at("warn")[0]?.meta).toEqual({
      category: "quickdraw.dev",
      warning: "n-plus-one",
      service: "taskService",
      method: "board",
      model: "task",
    });
  });

  it("log nothing outside development", () => {
    const logger = captureLogger();
    const warnings = createDevWarnings({ logger, development: false });
    expect(warnings.enabled).toBe(false);
    warnings.warn(nPlusOne);
    expect(logger.entries).toEqual([]);
  });

  it("throw a DevWarningError every time when strict, development or not", () => {
    const logger = captureLogger();
    const warnings = createDevWarnings({ logger, development: false, strict: true });
    expect(warnings.enabled).toBe(true);
    for (let round = 0; round < 2; round += 1) {
      const thrown: unknown = (() => {
        try {
          warnings.warn(nPlusOne);
          return undefined;
        } catch (error) {
          return error;
        }
      })();
      expect(thrown).toBeInstanceOf(DevWarningError);
      expect(thrown).toMatchObject({ name: "DevWarningError", warning: nPlusOne });
      expect((thrown as Error).message).toBe(formatDevWarning(nPlusOne));
    }
    expect(logger.entries).toEqual([]);
  });

  it("run code quietly, awaiting it inside, and nowhere else", async () => {
    expect(isQuiet()).toBe(false);
    const seen: boolean[] = [];
    const lazy: PromiseLike<string> = {
      then(onfulfilled, onrejected) {
        seen.push(isQuiet());
        return Promise.resolve("done").then(onfulfilled, onrejected);
      },
    };
    expect(await quietly(() => lazy)).toBe("done");
    expect(seen).toEqual([true]);
    expect(isQuiet()).toBe(false);
  });

  it("check the app's callbacks again inside a quiet kit handler", async () => {
    const inside = await quietly(async () => [
      isQuiet(),
      await checked(() => isQuiet()),
      await checked(async () => await quietly(() => isQuiet())),
      isQuiet(),
    ]);
    expect(inside).toEqual([true, false, true, true]);
    expect(await checked(() => isQuiet())).toBe(false);
  });
});

describe("repeated calls", () => {
  const service = qd.defineService(task, { methods: taskDefaults });
  const get = (input: unknown, connectionId?: string) => ({
    method: "get",
    input,
    ...(connectionId === undefined ? {} : { connectionId }),
  });
  const repeated = <Entry extends { readonly message: string }>(entries: readonly Entry[]) =>
    entries.filter((entry) => entry.message.startsWith("[quickdraw:repeated-call]"));

  it("are named once per connection, service and method when one input comes more than 10 times within a second", async () => {
    const { call, logger } = setup([service]);
    for (let round = 0; round < 10; round += 1) {
      await call(get({ id: "t1" }, "s1"));
    }
    expect(repeated(logger.at("warn"))).toEqual([]);
    for (let round = 0; round < 5; round += 1) {
      await call(get({ id: "t1" }, "s1"));
    }
    const [warning, ...rest] = repeated(logger.at("warn"));
    expect(rest).toEqual([]);
    expect(warning?.message).toBe(
      "[quickdraw:repeated-call] taskService.get: called 11 times within a second with the same input, on one connection (s1): " +
        "the client calls it in a loop, as a mutation fired from an effect or from render does, or a refetch that triggers itself. " +
        "Call it from an event handler, or guard the effect so it runs once per change",
    );
    expect(warning?.meta).toMatchObject({
      category: "quickdraw.dev",
      warning: "repeated-call",
      service: "taskService",
      method: "get",
      connectionId: "s1",
      calls: 11,
    });
    // another connection is counted on its own
    for (let round = 0; round < 11; round += 1) {
      await call(get({ id: "t1" }, "s2"));
    }
    expect(repeated(logger.at("warn"))).toHaveLength(2);
  });

  it("count neither other inputs nor calls without a connection", async () => {
    const { call, logger } = setup([service]);
    for (let round = 0; round < 20; round += 1) {
      await call(get({ id: `t${String(round)}` }, "s1"));
      await call(get({ id: "t1" }));
    }
    expect(repeated(logger.at("warn"))).toEqual([]);
  });

  it("are not counted outside development", async () => {
    const env = process.env.NODE_ENV;
    process.env.NODE_ENV = "production";
    try {
      const { call, logger } = setup([service]);
      for (let round = 0; round < 15; round += 1) {
        await call(get({ id: "t1" }, "s1"));
      }
      expect(repeated(logger.entries)).toEqual([]);
    } finally {
      process.env.NODE_ENV = env;
    }
  });

  it("reject the call that crossed the line in a strict app, once it was answered", async () => {
    const { call, records } = setup([service], { [STRICT_WARNINGS]: true } as never);
    for (let round = 0; round < 10; round += 1) {
      await call(get({ id: "t1" }, "s1"));
    }
    const answered: unknown[] = [];
    const eleventh = call({
      ...get({ id: "t1" }, "s1"),
      respond: (result) => answered.push(result),
    });
    await expect(eleventh).rejects.toBeInstanceOf(DevWarningError);
    await expect(eleventh).rejects.toThrow(
      "[quickdraw:repeated-call] taskService.get: called 11 times",
    );
    expect(answered).toHaveLength(1);
    expect(records).toHaveLength(11);
  });

  it("name a connection refused RATE_LIMITED more than 30 times within a minute, once, at warn", async () => {
    const held = deferred<number>();
    const counting = qd.defineService(task, {
      methods: { ...taskDefaults, count: { access: "public", handler: () => held.promise } },
    });
    const { call, logger } = setup([counting], {
      limits: { maxInFlightQueries: 1, maxQueuedQueries: 0 },
    });
    const running = call({ method: "count", input: { projectId: "p0" }, connectionId: "s1" });
    for (let round = 1; round <= 32; round += 1) {
      const refused = await call({
        method: "count",
        input: { projectId: `p${String(round)}` },
        connectionId: "s1",
      });
      expect(refused).toMatchObject({ ok: false, error: { code: "RATE_LIMITED" } });
    }
    held.resolve(0);
    await running;
    const warnings = repeated(logger.at("warn"));
    expect(warnings.map((entry) => entry.message)).toEqual([
      "[quickdraw:repeated-call] connection s1 was refused RATE_LIMITED 31 times within a minute (the last: taskService.count): " +
        "its client keeps calling while it is rate limited, as a loop does. The quickdraw client backs off on RATE_LIMITED; " +
        "find the call that repeats (a repeated-call warning names it) and stop the loop",
    ]);
    expect(warnings[0]?.meta).toMatchObject({ connectionId: "s1", refusals: 31 });
  });
});

function watch(strict = false) {
  const logger = captureLogger();
  let now = 0;
  const loops = createLoopWatch(
    createDevWarnings({ logger, development: true, strict }),
    logger,
    () => now,
  );
  return {
    loops,
    logger,
    advance: (ms: number) => {
      now += ms;
    },
  };
}

const call = (input: unknown, connectionId: string | undefined = "s1") => ({
  service: "taskService",
  method: "get",
  input,
  ...(connectionId === undefined ? {} : { connectionId }),
});

describe("the loop watch, with a clock the test moves", () => {
  it("counts identical calls within a second, and forgets the older ones", () => {
    const { loops, logger, advance } = watch();
    for (let round = 0; round < 30; round += 1) {
      loops.call(call({ id: "t1" }), "ok");
      advance(REPEATED_CALL_WINDOW_MS / 10);
    }
    // ten a second, never more
    expect(logger.at("warn")).toEqual([]);
    for (let round = 0; round < 11; round += 1) {
      loops.call(call({ id: "t1" }), "ok");
    }
    expect(logger.at("warn").map((entry) => entry.message)).toEqual([
      expect.stringContaining(
        "[quickdraw:repeated-call] taskService.get: called 11 times within a second",
      ),
    ]);
  });

  it("keys a long input by its hash, and skips one JSON cannot write", () => {
    const { loops, logger } = watch();
    const long = { text: "x".repeat(1_000) };
    const cyclic: Record<string, unknown> = {};
    cyclic.self = cyclic;
    for (let round = 0; round < 11; round += 1) {
      loops.call(call(cyclic), "ok");
      loops.call(call({ big: 1n }), "ok");
    }
    expect(logger.at("warn")).toEqual([]);
    for (let round = 0; round < 11; round += 1) {
      loops.call(call({ ...long }), "ok");
    }
    expect(logger.at("warn")).toHaveLength(1);
  });

  it("counts refusals per connection over a minute, from calls and from the socket rate limiter", () => {
    const { loops, logger, advance } = watch();
    for (let round = 0; round < 20; round += 1) {
      loops.call(call({ round }), "RATE_LIMITED");
      loops.refused("s2", "qd:call");
    }
    advance(REFUSAL_WINDOW_MS);
    for (let round = 0; round < 30; round += 1) {
      loops.refused("s1", "qd:call");
    }
    expect(logger.at("warn")).toEqual([]);
    loops.refused("s1", "qd:call");
    expect(logger.at("warn").map((entry) => entry.message)).toEqual([
      expect.stringContaining(
        "[quickdraw:repeated-call] connection s1 was refused RATE_LIMITED 31 times within a minute (the last: qd:call)",
      ),
    ]);
  });

  it("throws a call's warning in a strict app, and logs a refusal outside any call", () => {
    const { loops, logger } = watch(true);
    for (let round = 0; round < 10; round += 1) {
      loops.call(call({ id: "t1" }), "ok");
    }
    expect(() => loops.call(call({ id: "t1" }), "ok")).toThrow("[quickdraw:repeated-call]");
    for (let round = 0; round < 31; round += 1) {
      loops.refused("s9", "qd:call");
    }
    expect(logger.at("warn").map((entry) => entry.message)).toEqual([
      expect.stringContaining("connection s9 was refused RATE_LIMITED 31 times"),
    ]);
  });

  it("does nothing outside development", () => {
    const logger = captureLogger();
    const loops = createLoopWatch(createDevWarnings({ logger, development: false }), logger);
    for (let round = 0; round < 40; round += 1) {
      loops.call(call({ id: "t1" }), "RATE_LIMITED");
      loops.refused("s1", "qd:call");
    }
    expect(logger.entries).toEqual([]);
  });
});
