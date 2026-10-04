// The in-process caller (RFC 0003 section 10): `dispatcher.caller(principal)`
// and `qd.caller(principal)`.

import { describe, expect, it, vi } from "vitest";
import { QuickdrawError } from "../index";
import {
  alice,
  db,
  deferred,
  project,
  qd,
  task,
  taskDefaults,
  taskRow,
  tick,
} from "./__tests__/fixtures";
import { createDispatcher, initQuickdraw, type CallRecord } from "./index";

describe("dispatcher.caller", () => {
  it("calls through the whole pipeline with transport internal", async () => {
    const records: CallRecord[] = [];
    const seen = vi.fn();
    const taskService = qd.defineService(task, {
      methods: {
        ...taskDefaults,
        rename: {
          access: "authenticated",
          handler: ({ input, ctx }) => {
            seen(ctx.principal, ctx.transport);
            return taskRow({ id: input.id, title: input.title });
          },
        },
      },
    });
    const projectService = qd.defineService(project, {
      methods: {
        get: { access: "public", handler: ({ input }) => ({ id: input.id, name: "Docs" }) },
      },
    });
    const dispatcher = createDispatcher({
      services: [taskService, projectService],
      db,
      logger: silent(),
      onCall: (record) => records.push(record),
    });
    const caller = dispatcher.caller(alice);
    expect(await caller.taskService.rename({ id: "t2", title: "Renamed" })).toEqual(
      taskRow({ id: "t2", title: "Renamed" }),
    );
    expect(await dispatcher.caller(null).projectService.get({ id: "p1" })).toEqual({
      id: "p1",
      name: "Docs",
    });
    expect(seen).toHaveBeenCalledWith(alice, "internal");
    expect(
      records.map((record) => [record.service, record.method, record.transport, record.outcome]),
    ).toEqual([
      ["taskService", "rename", "internal", "ok"],
      ["projectService", "get", "internal", "ok"],
    ]);
  });

  it("rejects with the call's QuickdrawError, keeping the original of an INTERNAL", async () => {
    const original = new Error("boom");
    const service = qd.defineService(task, {
      methods: {
        ...taskDefaults,
        get: { access: "public", handler: () => Promise.reject(original) },
      },
    });
    const caller = createDispatcher({ services: [service], db, logger: silent() }).caller(null);
    await expect(caller.taskService.rename({ id: "t1", title: "x" })).rejects.toMatchObject({
      code: "UNAUTHENTICATED",
    });
    await expect(caller.taskService.rename({ id: "t1", title: "" })).rejects.toMatchObject({
      code: "VALIDATION",
    });
    const error: unknown = await caller.taskService
      .get({ id: "t1" })
      .catch((reason: unknown) => reason);
    expect(error).toBeInstanceOf(QuickdrawError);
    expect(error).toMatchObject({ code: "INTERNAL", message: "Internal error", cause: original });
    const loose = caller as unknown as Record<
      string,
      Record<string, (input?: unknown) => Promise<unknown>>
    >;
    await expect(loose.chatService?.get?.({ id: "c1" })).rejects.toMatchObject({
      code: "NOT_FOUND",
    });
  });

  it("cancels a query through its signal, and is never mistaken for a promise", async () => {
    const gate = deferred<number>();
    const service = qd.defineService(task, {
      methods: { ...taskDefaults, count: { access: "public", handler: () => gate.promise } },
    });
    const caller = createDispatcher({ services: [service], db, logger: silent() }).caller(alice);
    const controller = new AbortController();
    const pending = caller.taskService.count({ projectId: "p1" }, { signal: controller.signal });
    await tick();
    controller.abort();
    await expect(pending).rejects.toMatchObject({ code: "CANCELLED" });
    gate.resolve(1);
    expect(await Promise.resolve(caller)).toBe(caller);
    expect(await Promise.resolve(caller.taskService)).toBe(caller.taskService);
    expect(caller.taskService.count).toBe(caller.taskService.count);
  });
});

describe("qd.caller", () => {
  it("calls through the dispatcher its qd created last, and fails clearly before there is one", async () => {
    const app = initQuickdraw<{ db: typeof db; contracts: { task: typeof task } }>();
    const first = app.defineService(task, { methods: taskDefaults });
    const second = app.defineService(task, {
      methods: { ...taskDefaults, count: { access: "public", handler: () => 2 } },
    });
    const caller = app.caller(null);
    await expect(caller.taskService.count({ projectId: "p1" })).rejects.toThrow(
      "qd.caller has no dispatcher to call through",
    );
    app.createDispatcher({ services: [first], db, logger: silent() });
    expect(await caller.taskService.count({ projectId: "p1" })).toBe(0);
    app.createDispatcher({ services: [second], db, logger: silent() });
    expect(await caller.taskService.count({ projectId: "p1" })).toBe(2);
  });
});

function silent() {
  const noop = (): void => undefined;
  const logger = { debug: noop, info: noop, warn: noop, error: noop, child: () => logger };
  return logger;
}
