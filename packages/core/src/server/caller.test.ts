// The in-process caller (RFC 0003 section 10): `dispatcher.caller(principal)`
// and `qd.caller(principal)`, and the grants a server's callers load.

import { afterEach, describe, expect, it, vi } from "vitest";
import { QuickdrawError } from "../index";
import {
  alice,
  db,
  type AppPrincipal,
  deferred,
  granted,
  project,
  qd,
  task,
  taskDefaults,
  taskRow,
  tick,
} from "./__tests__/fixtures";
import { createDispatcher, initQuickdraw, type CallRecord, type QuickdrawServer } from "./index";
import { probe } from "./transports/__tests__/probe";

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

describe("the grants of an in-process caller (finding F5.1)", () => {
  type Grants = Record<string, "Read" | "Moderate" | "Admin">;

  /** An app whose types name the probe's contract, so `app.caller` is typed. */
  const app = initQuickdraw<{
    db: typeof db;
    principal: AppPrincipal;
    contracts: { probe: typeof probe };
  }>();

  const servers: QuickdrawServer[] = [];
  afterEach(async () => {
    await Promise.all(servers.splice(0).map(async (server) => await server.close()));
  });

  /** The probe service, as `app` defines it. */
  function probeService() {
    return app.defineService(probe, {
      methods: {
        echo: {
          access: "public",
          handler: ({ input, ctx }) => ({
            text: input.text,
            userId: ctx.principal?.userId ?? null,
            transport: ctx.transport,
            grants: ctx.principal?.serviceAccess ?? null,
          }),
        },
        fail: { access: "public", handler: () => null },
        failOddly: { access: "public", handler: () => null },
        wait: { access: "authenticated", handler: () => "" },
        unencodable: { access: "public", handler: () => null },
        moderate: { access: { service: "Moderate" }, handler: ({ input }) => input.value * 2 },
      },
    });
  }

  /** A server of the probe service whose grants loader reads `stored`, counting its loads. */
  function serve(stored: Record<string, Grants | undefined>, fail?: () => boolean) {
    const loads: string[] = [];
    const server = app.createServer({
      services: [probeService()],
      db,
      logger: silent(),
      auth: {
        loadServiceAccess: (userId) => {
          loads.push(userId);
          if (fail?.() === true) {
            throw new Error("the grants store is down");
          }
          return stored[userId] ?? null;
        },
      },
    });
    servers.push(server as unknown as QuickdrawServer);
    return { server, loads };
  }

  it("gives a principal that carries none the grants the server loads, once per caller", async () => {
    const { server, loads } = serve({ alice: { probeService: "Moderate" } });
    const caller = app.caller(alice);
    expect(loads).toEqual([]);
    expect(await caller.probeService.echo({ text: "a" })).toMatchObject({
      userId: "alice",
      transport: "internal",
      grants: { probeService: "Moderate" },
    });
    expect(await caller.probeService.moderate({ value: 2 })).toBe(4);
    expect(loads).toEqual(["alice"]);
    // The server's own caller loads them too; each caller loads once.
    expect(await server.dispatcher.caller(alice).probeService.moderate({ value: 3 })).toBe(6);
    expect(loads).toEqual(["alice", "alice"]);
    // An anonymous caller has nothing to load.
    expect(await app.caller(null).probeService.echo({ text: "n" })).toMatchObject({ grants: null });
    expect(loads).toHaveLength(2);
  });

  it("keeps exactly the grants a principal carries, even none", async () => {
    const { loads } = serve({ alice: { probeService: "Moderate" } });
    await expect(
      app.caller(granted(alice, {})).probeService.moderate({ value: 1 }),
    ).rejects.toMatchObject({ code: "FORBIDDEN" });
    const carried = granted(alice, { probeService: "Moderate" });
    expect(await app.caller(carried).probeService.echo({ text: "c" })).toMatchObject({
      grants: { probeService: "Moderate" },
    });
    expect(loads).toEqual([]);
  });

  it("loads them again once the server applied new grants, as a socket's are refreshed", async () => {
    const stored: Record<string, Grants | undefined> = { alice: { probeService: "Moderate" } };
    const { server, loads } = serve(stored);
    const caller = app.caller(alice);
    expect(await caller.probeService.moderate({ value: 2 })).toBe(4);
    // Kept, like a socket's, until the server is told the grants changed.
    stored.alice = {};
    expect(await caller.probeService.moderate({ value: 2 })).toBe(4);
    expect(loads).toEqual(["alice"]);
    await server.access.refresh("alice");
    await expect(caller.probeService.moderate({ value: 2 })).rejects.toMatchObject({
      code: "FORBIDDEN",
    });
    // The refresh's own load, then the caller's.
    expect(loads).toEqual(["alice", "alice", "alice"]);
  });

  it("fails the call with INTERNAL when the load fails, and loads again at the next call", async () => {
    let down = true;
    const { loads } = serve({ alice: { probeService: "Moderate" } }, () => down);
    const caller = app.caller(alice);
    const error: unknown = await caller.probeService
      .moderate({ value: 1 })
      .catch((reason: unknown) => reason);
    expect(error).toBeInstanceOf(QuickdrawError);
    expect(error).toMatchObject({
      code: "INTERNAL",
      message: "Internal error",
      cause: new Error("the grants store is down"),
    });
    down = false;
    expect(await caller.probeService.moderate({ value: 1 })).toBe(2);
    expect(loads).toEqual(["alice", "alice"]);
  });

  it("loads nothing through a dispatcher without a server's auth", async () => {
    const dispatcher = createDispatcher({ services: [probeService()], db, logger: silent() });
    expect(await dispatcher.caller(alice).probeService.echo({ text: "d" })).toMatchObject({
      grants: null,
    });
  });
});

function silent() {
  const noop = (): void => undefined;
  const logger = { debug: noop, info: noop, warn: noop, error: noop, child: () => logger };
  return logger;
}
