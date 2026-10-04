import { AsyncLocalStorage } from "node:async_hooks";
import { afterEach, describe, expect, it, vi } from "vitest";
import { QuickdrawError } from "../index";
import {
  alice,
  bob,
  captureLogger,
  db,
  granted,
  project,
  qd,
  setup,
  task,
  taskDefaults,
  taskRow,
  tick,
} from "./__tests__/fixtures";
import {
  createBasicAccessEngine,
  createDispatcher,
  custom,
  initQuickdraw,
  resolver,
  toCallReply,
  type DispatchResult,
  type UnitOfWorkFactory,
  type UnitOfWorkScope,
} from "./index";
import { untrackedUnitOfWork } from "./uow/untracked";
import { createContext } from "./context";

afterEach(() => {
  vi.unstubAllEnvs();
});

function failure(result: DispatchResult): QuickdrawError {
  if (result.ok) {
    throw new Error(`expected a failure, got ${JSON.stringify(result)}`);
  }
  return result.error;
}

describe("step 1: lookup", () => {
  const service = qd.defineService(task, { methods: taskDefaults });

  it("answers NOT_FOUND for an unknown service or method", async () => {
    const { call, records } = setup([service]);
    const unknownService = failure(await call({ service: "chatService", method: "get" }));
    expect(unknownService.code).toBe("NOT_FOUND");
    expect(unknownService.message).toBe('Unknown service "chatService"');
    const unknownMethod = failure(await call({ method: "remove" }));
    expect(unknownMethod.code).toBe("NOT_FOUND");
    expect(unknownMethod.message).toBe('Unknown method "remove" on service "taskService"');
    expect(failure(await call({ method: "toString" })).code).toBe("NOT_FOUND");
    expect(records.map((record) => [record.outcome, record.kind])).toEqual([
      ["NOT_FOUND", undefined],
      ["NOT_FOUND", undefined],
      ["NOT_FOUND", undefined],
    ]);
  });
});

describe("step 3: input validation", () => {
  it("answers VALIDATION with the issue paths, and never runs the handler", async () => {
    const handler = vi.fn(() => taskRow());
    const service = qd.defineService(task, {
      methods: { ...taskDefaults, rename: { access: "authenticated", handler } },
    });
    const { call } = setup([service]);
    const error = failure(await call({ method: "rename", input: { id: 7, title: "" } }));
    expect(error.code).toBe("VALIDATION");
    expect(error.message).toBe("Invalid input for taskService.rename");
    expect(error.data).toEqual({
      issues: [
        { path: ["id"], message: expect.any(String) },
        { path: ["title"], message: expect.any(String) },
      ],
    });
    expect(toCallReply({ ok: false, error })).toEqual({
      ok: false,
      e: { code: "VALIDATION", message: error.message, data: error.data },
    });
    expect(handler).not.toHaveBeenCalled();
  });

  it("hands the handler the parsed input, with defaults applied", async () => {
    const handler = vi.fn(({ input }: { readonly input: { limit: number } }) =>
      Array.from({ length: input.limit }, (_, index) => ({ id: `t${index}`, title: "card" })),
    );
    const service = qd.defineService(task, {
      methods: { ...taskDefaults, list: { access: "public", handler } },
    });
    const result = await setup([service]).call({ method: "list", input: { projectId: "p1" } });
    expect(result).toEqual({
      ok: true,
      data: [
        { id: "t0", title: "card" },
        { id: "t1", title: "card" },
      ],
    });
    expect(handler.mock.calls[0]?.[0].input).toEqual({ projectId: "p1", limit: 2 });
  });
});

describe("step 4: authorization", () => {
  it("lets anyone call a public method, and only a principal call the others", async () => {
    const service = qd.defineService(task, { methods: taskDefaults });
    const { call } = setup([service]);
    expect(await call({ method: "get", input: { id: "t1" }, principal: null })).toEqual({
      ok: true,
      data: taskRow(),
    });
    const error = failure(
      await call({ method: "rename", input: { id: "t1", title: "x" }, principal: null }),
    );
    expect(error.code).toBe("UNAUTHENTICATED");
  });

  it("checks service grants, and passes a custom check its ctx and parsed input", async () => {
    const check = vi.fn(
      (ctx: { readonly principal: { readonly userId: string } }, input: { limit: number }) =>
        ctx.principal.userId === "alice" && input.limit === 2,
    );
    const service = qd.defineService(task, {
      methods: {
        ...taskDefaults,
        count: { access: { service: "Moderate" }, handler: () => 1 },
        list: { access: custom(check), handler: () => [] },
      },
    });
    const { call } = setup([service]);
    const moderator = granted(alice, { taskService: "Moderate" });
    expect(
      await call({ method: "count", input: { projectId: "p1" }, principal: moderator }),
    ).toEqual({ ok: true, data: 1 });
    const reader = granted(alice, { taskService: "Read" });
    expect(
      failure(await call({ method: "count", input: { projectId: "p1" }, principal: reader })).code,
    ).toBe("FORBIDDEN");
    expect(await call({ method: "list", input: { projectId: "p1" } })).toEqual({
      ok: true,
      data: [],
    });
    expect(
      failure(await call({ method: "list", input: { projectId: "p1" }, principal: bob })).code,
    ).toBe("FORBIDDEN");
    expect(check.mock.calls[0]?.[1]).toEqual({ projectId: "p1", limit: 2 });
    expect(check.mock.calls[0]?.[0]).toMatchObject({ principal: alice, transport: "socket" });
  });

  it("fails an entry check with INTERNAL when the app's own engine decides no rows", async () => {
    const service = qd.defineService(task, {
      model: "task",
      access: resolver({ levelsFor: () => ({ t1: "Admin" }) }),
      methods: {
        ...taskDefaults,
        rename: { access: { entry: "Moderate" }, handler: () => taskRow() },
      },
    });
    const { call, logger } = setup([service], { access: createBasicAccessEngine() });
    const result = await call({ method: "rename", input: { id: "t1", title: "x" } });
    expect(toCallReply(result)).toEqual({
      ok: false,
      e: { code: "INTERNAL", message: "Internal error" },
    });
    expect(failure(result).message).toBe(
      "taskService.rename uses entry access, but no access policy is configured for taskService",
    );
    expect(logger.at("error")[0]?.meta?.error).toMatchObject({
      message:
        "taskService.rename uses entry access, but no access policy is configured for taskService",
    });
  });
});

describe("step 5: not modified", () => {
  it("answers not modified when the caller holds the current version, after access was checked", async () => {
    const handler = vi.fn(() => 5);
    const version = vi.fn(({ projectId }: { projectId: string }) => `${projectId}@3`);
    const service = qd.defineService(task, {
      methods: { ...taskDefaults, count: { access: "authenticated", version, handler } },
    });
    const { call, records } = setup([service]);
    const input = { projectId: "p1" };
    expect(await call({ method: "count", input })).toEqual({ ok: true, data: 5, version: "p1@3" });
    expect(await call({ method: "count", input, v: "p1@3" })).toEqual({
      ok: true,
      notModified: true,
      version: "p1@3",
    });
    expect(await call({ method: "count", input, v: "p1@2" })).toEqual({
      ok: true,
      data: 5,
      version: "p1@3",
    });
    expect(handler).toHaveBeenCalledTimes(2);
    expect(records.map((record) => record.outcome)).toEqual(["ok", "not-modified", "ok"]);
    expect(toCallReply({ ok: true, notModified: true, version: "p1@3" })).toEqual({
      ok: true,
      nm: true,
      v: "p1@3",
    });
    expect(failure(await call({ method: "count", input, principal: null, v: "p1@3" })).code).toBe(
      "UNAUTHENTICATED",
    );
    expect(version).toHaveBeenCalledTimes(3);
  });

  it("asks the versions source for queries without their own version, never for mutations", async () => {
    const versionOf = vi.fn((_request: unknown) => 42);
    const service = qd.defineService(task, { methods: taskDefaults });
    const { call } = setup([service], { versions: { versionOf } });
    expect(await call({ method: "get", input: { id: "t1" }, v: 42 })).toEqual({
      ok: true,
      notModified: true,
      version: 42,
    });
    expect(versionOf.mock.calls[0]?.[0]).toMatchObject({ input: { id: "t1" } });
    expect(await call({ method: "rename", input: { id: "t1", title: "x" }, v: 42 })).toEqual({
      ok: true,
      data: taskRow(),
    });
    expect(versionOf).toHaveBeenCalledTimes(1);
  });
});

describe("errors", () => {
  it("passes a thrown QuickdrawError through with its code, message and data", async () => {
    const service = qd.defineService(task, {
      methods: {
        ...taskDefaults,
        get: {
          access: "public",
          handler: () => {
            throw new QuickdrawError("CONFLICT", "Already archived", { archivedAt: 3 });
          },
        },
      },
    });
    const error = failure(await setup([service]).call({ method: "get", input: { id: "t1" } }));
    expect([error.code, error.message, error.data]).toEqual([
      "CONFLICT",
      "Already archived",
      { archivedAt: 3 },
    ]);
  });

  it("turns anything else into INTERNAL with the generic message, and logs the original in full", async () => {
    const original = new Error("connection refused: postgres://secret@db");
    const service = qd.defineService(task, {
      methods: {
        ...taskDefaults,
        get: { access: "public", handler: () => Promise.reject(original) },
        find: {
          access: "public",
          handler: () => {
            throw new TypeError("sync failure");
          },
        },
      },
    });
    const { call, logger } = setup([service]);
    const error = failure(await call({ method: "get", input: { id: "t1" } }));
    expect([error.code, error.message, error.cause]).toEqual([
      "INTERNAL",
      "Internal error",
      original,
    ]);
    expect(JSON.stringify(toCallReply({ ok: false, error }))).not.toContain("secret");
    const [entry] = logger.at("error");
    expect(entry?.message).toMatch(/^taskService\.get INTERNAL in \d+ ms$/);
    expect(entry?.meta?.error).toMatchObject({
      code: "INTERNAL",
      cause: { name: "Error", message: original.message, stack: original.stack },
    });
    expect(failure(await call({ method: "find", input: { id: "t1" } })).code).toBe("INTERNAL");
  });

  it("maps Prisma's unique and missing-row errors", async () => {
    const prismaError = (code: string): Error =>
      Object.assign(new Error(`Prisma ${code}`), { name: "PrismaClientKnownRequestError", code });
    const service = qd.defineService(task, {
      methods: {
        ...taskDefaults,
        rename: { access: "authenticated", handler: () => Promise.reject(prismaError("P2002")) },
        get: { access: "public", handler: () => Promise.reject(prismaError("P2025")) },
        find: { access: "public", handler: () => Promise.reject(prismaError("P2003")) },
      },
    });
    const { call } = setup([service]);
    expect(failure(await call({ method: "rename", input: { id: "t1", title: "x" } })).code).toBe(
      "CONFLICT",
    );
    expect(failure(await call({ method: "get", input: { id: "t1" } })).code).toBe("NOT_FOUND");
    expect(failure(await call({ method: "find", input: { id: "t1" } })).code).toBe("INTERNAL");
  });
});

describe("step 8: output validation", () => {
  const wrong = qd.defineService(task, {
    methods: {
      ...taskDefaults,
      get: {
        access: "public",
        handler: () => ({ id: "t1" }) as unknown as ReturnType<typeof taskRow>,
      },
      list: { access: "public", handler: () => [{ id: "t1", title: 7 }] as unknown as [] },
      find: { access: "public", handler: () => null },
    },
  });

  it("fails a result that does not match the contract with INTERNAL, naming the issues", async () => {
    const { call, logger } = setup([wrong]);
    const error = failure(await call({ method: "get", input: { id: "t1" } }));
    expect(error.code).toBe("INTERNAL");
    expect(error.message).toBe(
      "taskService.get returned a value that does not match its contract output",
    );
    expect(error.data).toMatchObject({
      issues: expect.arrayContaining([{ path: ["projectId"], message: expect.any(String) }]),
    });
    expect(toCallReply({ ok: false, error })).toEqual({
      ok: false,
      e: { code: "INTERNAL", message: "Internal error" },
    });
    expect(logger.at("error")).toHaveLength(1);
    const list = failure(await call({ method: "list", input: { projectId: "p1" } }));
    expect(list.data).toEqual({ issues: [{ path: [0, "title"], message: expect.any(String) }] });
    expect(await call({ method: "find", input: { id: "t1" } })).toEqual({ ok: true, data: null });
  });

  it("is on outside production by default, and can be turned off", async () => {
    expect(
      (
        await setup([wrong], { outputValidation: false }).call({
          method: "get",
          input: { id: "t1" },
        })
      ).ok,
    ).toBe(true);
    vi.stubEnv("NODE_ENV", "production");
    expect((await setup([wrong]).call({ method: "get", input: { id: "t1" } })).ok).toBe(true);
  });
});

describe("step 9: the completion record, logging and respond", () => {
  const service = qd.defineService(task, { methods: taskDefaults });

  it("emits one record per call with the call's numbers", async () => {
    const { call, records } = setup([service]);
    const respond = vi.fn(() => 321);
    await call({ method: "get", input: { id: "t1" }, requestId: "req-1", respond });
    expect(respond).toHaveBeenCalledExactlyOnceWith({ ok: true, data: taskRow() });
    expect(records).toEqual([
      {
        service: "taskService",
        method: "get",
        kind: "query",
        transport: "socket",
        requestId: "req-1",
        outcome: "ok",
        durationMs: expect.any(Number),
        queueMs: 0,
        bytes: 321,
        shared: false,
        sqlStatements: undefined,
      },
    ]);
    await call({ method: "rename", input: { id: "t1", title: "x" }, transport: "http" });
    expect(records[1]).toMatchObject({ kind: "mutation", transport: "http", bytes: 0 });
    expect(records[1]?.requestId).toMatch(/^[0-9a-f-]{36}$/);
  });

  it("logs each call once: debug normally, warn when slow or large, error for INTERNAL", async () => {
    // A generous slowMs: the first calls of a cold run (a CI runner compiling
    // the schemas) can take tens of milliseconds, and must still log at debug.
    // The slow call below gets its own dispatcher with a small slowMs.
    const { call, logger } = setup([service], { slowMs: 60_000, maxResponseBytes: 100 });
    await call({ method: "get", input: { id: "t1" }, principal: null });
    await call({ method: "rename", input: { id: "t1", title: "x" }, principal: null });
    expect(logger.entries.map((entry) => [entry.level, entry.message.split(" in ")[0]])).toEqual([
      ["debug", "taskService.get ok"],
      ["debug", "taskService.rename UNAUTHENTICATED"],
    ]);
    expect(logger.entries[1]?.meta).toMatchObject({
      category: "quickdraw.call",
      outcome: "UNAUTHENTICATED",
    });
    await call({ method: "get", input: { id: "t1" }, respond: () => 101 });
    expect(logger.entries[2]).toMatchObject({
      level: "warn",
      meta: { bytes: 101, userId: "alice" },
    });
    // Waits by the clock the pipeline reads, not by a timer, which may fire a
    // few milliseconds early by that clock.
    const pastSlowMs = async (): Promise<number> => {
      const until = performance.now() + 40;
      while (performance.now() < until) {
        await tick(5);
      }
      return 1;
    };
    const slow = qd.defineService(task, {
      methods: { ...taskDefaults, count: { access: "public", handler: pastSlowMs } },
    });
    const slowSetup = setup([slow], { slowMs: 30 });
    await slowSetup.call({ method: "count", input: { projectId: "p1" } });
    expect(slowSetup.logger.entries.map((entry) => entry.level)).toEqual(["warn"]);
  });

  it("logs and survives a respond or onCall that throws", async () => {
    const logger = captureLogger();
    const dispatcher = createDispatcher({
      services: [service],
      db,
      logger,
      onCall: () => {
        throw new Error("metrics down");
      },
    });
    const result = await dispatcher.call({
      service: "taskService",
      method: "get",
      input: { id: "t1" },
      principal: alice,
      transport: "socket",
      respond: () => {
        throw new Error("socket closed");
      },
    });
    expect(result).toEqual({ ok: true, data: taskRow() });
    expect(logger.at("error").map((entry) => entry.message)).toEqual([
      "A transport failed to send a reply",
      "onCall threw; the call was not affected",
    ]);
  });
});

describe("the handler's ctx", () => {
  it("carries the principal, transport, request id, a call logger and a signal", async () => {
    let seen: Record<string, unknown> = {};
    const service = qd.defineService(task, {
      methods: {
        ...taskDefaults,
        rename: {
          access: "authenticated",
          handler: ({ ctx, db: database }) => {
            seen = { ...ctx, db: database };
            return taskRow();
          },
        },
      },
    });
    const { call, logger } = setup([service]);
    await call({
      method: "rename",
      input: { id: "t1", title: "x" },
      transport: "mcp",
      requestId: "req-9",
    });
    expect(seen).toMatchObject({
      principal: alice,
      transport: "mcp",
      requestId: "req-9",
      db,
      log: logger,
    });
    expect(seen.signal).toBeInstanceOf(AbortSignal);
  });

  it("adds the app's context fields, without letting them replace the framework's", async () => {
    const app = initQuickdraw<{ principal: typeof alice; context: { tenant: string } }>({
      context: (base) => ({
        tenant: `tenant-of-${base.principal?.userId ?? "nobody"}`,
        requestId: "spoofed",
      }),
    });
    let ctx: { tenant: string; requestId: string } | undefined;
    const service = app.defineService(task, {
      methods: {
        ...taskDefaults,
        count: {
          access: custom((check) => check.tenant === "tenant-of-alice"),
          handler: ({ ctx: handlerCtx }) => {
            ctx = handlerCtx;
            return 1;
          },
        },
      },
    });
    const { call } = setup([service]);
    expect(await call({ method: "count", input: { projectId: "p1" }, requestId: "real" })).toEqual({
      ok: true,
      data: 1,
    });
    expect(ctx).toMatchObject({ tenant: "tenant-of-alice", requestId: "real" });
  });

  it("gives ctx.mcp the request's MCP fields, also to the app's context, and leaves it out otherwise", async () => {
    const app = initQuickdraw<{
      principal: typeof alice;
      mcp: { readonly scopes: readonly string[] };
      context: { writer: boolean };
    }>({
      context: (base) => ({ writer: base.mcp?.scopes.includes("write") ?? false }),
    });
    const seen: Record<string, unknown>[] = [];
    const service = app.defineService(task, {
      methods: {
        ...taskDefaults,
        count: {
          access: custom((check) => check.mcp === undefined || check.mcp.scopes.length > 0),
          handler: ({ ctx }) => {
            seen.push({ ...ctx });
            return 0;
          },
        },
      },
    });
    const { call } = setup([service]);
    const input = { projectId: "p1" };
    await call({ method: "count", input, transport: "mcp", mcp: { scopes: ["write"] } });
    await call({ method: "count", input });
    const refused = await call({ method: "count", input, transport: "mcp", mcp: { scopes: [] } });
    expect(seen[0]).toMatchObject({ transport: "mcp", mcp: { scopes: ["write"] }, writer: true });
    expect(seen[1]).toMatchObject({ transport: "socket", writer: false });
    expect(seen[1]).not.toHaveProperty("mcp");
    expect(failure(refused).code).toBe("FORBIDDEN");
  });

  it("calls the app's services through ctx.services, as the same principal over transport internal", async () => {
    const seen: unknown[] = [];
    const projectService = qd.defineService(project, {
      methods: {
        get: {
          access: "authenticated",
          handler: ({ input, ctx }) => {
            seen.push({ principal: ctx.principal, transport: ctx.transport });
            return { id: input.id, name: "Board" };
          },
        },
      },
    });
    const service = qd.defineService(task, {
      methods: {
        ...taskDefaults,
        count: {
          access: "public",
          handler: async ({ input, ctx }) => {
            // These fixtures' app declares no contracts, so ctx.services is untyped.
            const board = await ctx.services.projectService?.get?.({ id: input.projectId });
            return (board as { readonly name: string }).name.length;
          },
        },
      },
    });
    const { call, records } = setup([service, projectService]);
    expect(await call({ method: "count", input: { projectId: "p1" } })).toEqual({
      ok: true,
      data: 5,
    });
    expect(seen).toEqual([{ principal: alice, transport: "internal" }]);
    expect(
      records.map((record) => `${record.service}.${record.method} ${record.transport}`),
    ).toEqual(["projectService.get internal", "taskService.count socket"]);
    // The inner call checks access: an anonymous caller is refused there, and the outer call fails with it.
    const refused = failure(
      await call({ method: "count", input: { projectId: "p1" }, principal: null }),
    );
    expect(refused.code).toBe("UNAUTHENTICATED");
  });

  it("throws INTERNAL from ctx.services of a context no dispatcher built", () => {
    const ctx = createContext({
      principal: null,
      signal: new AbortController().signal,
      log: captureLogger(),
      requestId: "r1",
      transport: "internal",
    });
    expect(JSON.stringify(ctx.services)).toBe("{}");
    expect(() => (ctx.services as Record<string, unknown>).projectService).toThrow(
      /ctx\.services\.projectService needs a dispatcher/,
    );
  });

  it("gives ctx.rooms, which joins nothing without a socket, and ctx.presence, which sees nobody without a server", async () => {
    const seen: unknown[] = [];
    const service = qd.defineService(task, {
      methods: {
        ...taskDefaults,
        count: {
          access: "public",
          handler: async ({ ctx }) => {
            seen.push(ctx.rooms.join("lobby"), ctx.rooms.leave("lobby"));
            seen.push(await ctx.presence.isOnline("u1"), await ctx.presence.users("lobby"));
            return 0;
          },
        },
      },
    });
    await setup([service]).call({ method: "count", input: { projectId: "p1" } });
    expect(seen).toEqual([false, false, false, []]);
  });

  it("gives ctx.touch that does nothing when the database client is not tracked", async () => {
    const touched: unknown[] = [];
    const service = qd.defineService(task, {
      methods: {
        ...taskDefaults,
        count: {
          access: "public",
          handler: ({ ctx }) => {
            touched.push(
              ctx.touch("task", ["t1", "t2"]),
              ctx.touch("task", "t3", { removed: true }),
            );
            expect(() => ctx.touch("task", [""])).toThrow(TypeError);
            return 0;
          },
        },
      },
    });
    const result = await setup([service]).call({ method: "count", input: { projectId: "p1" } });
    expect(result).toEqual({ ok: true, data: 0 });
    expect(touched).toEqual([undefined, undefined]);
  });
});

describe("step 7: the unit of work", () => {
  it("awaits a lazy result inside its scope, so tracked writes see it", async () => {
    const scope = new AsyncLocalStorage<string>();
    let seenIn: string | undefined;
    // Like a Prisma promise: nothing runs until something calls `then`.
    const lazy: PromiseLike<number> = {
      then(onfulfilled, onrejected) {
        seenIn = scope.getStore();
        return Promise.resolve(7).then(onfulfilled, onrejected);
      },
    };
    const unit = untrackedUnitOfWork.begin({} as UnitOfWorkScope);
    expect(await scope.run("unit", () => unit.run(() => lazy))).toBe(7);
    expect(seenIn).toBe("unit");
  });

  it("runs every handler in a unit, flushes it after respond and before the record", async () => {
    const events: string[] = [];
    const scopes: UnitOfWorkScope[] = [];
    const flushed: string[] = [];
    const flushSink = {
      flush: (writes: readonly unknown[]) => {
        flushed.push(`app sink: ${writes.length}`);
        return Promise.resolve();
      },
    };
    const unitOfWork: UnitOfWorkFactory = {
      begin(scope) {
        scopes.push(scope);
        return {
          sqlStatements: 2,
          run: async (fn) => {
            events.push("run");
            return await fn();
          },
          flush: () => {
            events.push("flush");
            return Promise.reject(new Error("emit failed"));
          },
        };
      },
    };
    const service = qd.defineService(task, { methods: taskDefaults });
    const logger = captureLogger();
    const dispatcher = createDispatcher({
      services: [service],
      db,
      logger,
      unitOfWork,
      flushSink,
      onCall: (record) => events.push(`record:${record.sqlStatements}`),
    });
    const result = await dispatcher.call({
      service: "taskService",
      method: "rename",
      input: { id: "t1", title: "x" },
      principal: alice,
      transport: "socket",
      requestId: "req-2",
      respond: () => {
        events.push("respond");
        return 1;
      },
    });
    expect(result.ok).toBe(true);
    expect(events).toEqual(["run", "respond", "flush", "record:2"]);
    expect(scopes).toEqual([
      {
        service: "taskService",
        method: "rename",
        kind: "mutation",
        requestId: "req-2",
        transport: "socket",
        sink: expect.objectContaining({ flush: expect.any(Function) }),
        // The dispatcher's warnings: those raised in the call go there.
        warnings: expect.objectContaining({ enabled: true, strict: false }),
      },
    ]);
    // The unit's sink is the dispatcher's own sinks, then the app's.
    await scopes[0]?.sink.flush([], { requestId: "req-2", transport: "socket", rev: 1 });
    expect(flushed).toEqual(["app sink: 0"]);
    expect(logger.at("error")[0]?.message).toBe(
      "Flushing a call's writes failed; its reply was already sent",
    );
  });
});

describe("adminBypass", () => {
  it("lets a service Admin pass every check unless the service turns it off", async () => {
    const methods = {
      ...taskDefaults,
      count: { access: custom(() => false), handler: () => 1 },
    };
    const admin = granted(alice, { taskService: "Admin" });
    const bypassing = setup([qd.defineService(task, { methods })]);
    expect(
      await bypassing.call({ method: "count", input: { projectId: "p1" }, principal: admin }),
    ).toEqual({ ok: true, data: 1 });
    const strict = setup([qd.defineService(task, { methods, adminBypass: false })]);
    expect(
      failure(await strict.call({ method: "count", input: { projectId: "p1" }, principal: admin }))
        .code,
    ).toBe("FORBIDDEN");
  });
});

describe("a dispatcher's resolved limits", () => {
  it("applies the RFC defaults and rejects impossible limits", async () => {
    const service = qd.defineService(task, { methods: taskDefaults });
    expect(setup([service]).dispatcher.limits).toEqual({
      maxInFlightQueries: 16,
      maxQueuedQueries: 64,
      callTimeoutMs: 30_000,
      retryAfterMs: 1_000,
      subscriptions: { maxInFlight: 8, maxQueued: 64 },
    });
    expect(
      createDispatcher({ services: [service], db, limits: { subscriptions: { maxQueued: 2 } } })
        .limits.subscriptions,
    ).toEqual({ maxInFlight: 8, maxQueued: 2 });
    expect(() =>
      createDispatcher({ services: [service], db, limits: { maxInFlightQueries: 0 } }),
    ).toThrow(/maxInFlightQueries must be at least 1/);
    expect(() =>
      createDispatcher({ services: [service], db, limits: { subscriptions: { maxInFlight: 0 } } }),
    ).toThrow(/limits.subscriptions.maxInFlight must be at least 1/);
    expect(() =>
      createDispatcher({
        services: [service],
        db,
        limits: { subscriptions: { maxQueued: -1 } },
      }),
    ).toThrow(/limits.subscriptions.maxQueued must be an integer/);
    expect(() =>
      createDispatcher({ services: [service], db, limits: { callTimeoutMs: 2 ** 31 } }),
    ).toThrow(/callTimeoutMs must be an integer/);
    await tick();
  });
});
