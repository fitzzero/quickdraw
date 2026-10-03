// `createServer` around its transports: shutdown, signals, `qd:rotate`,
// `access.refresh`, the app's own Express app and HTTP server, and
// `qd.createServer` as the dispatcher `qd.caller` calls through.

import { createServer as createHttpServer } from "node:http";
import express from "express";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  alice,
  bob,
  captureLogger,
  db,
  granted,
  qd,
  task,
  taskDefaults,
  taskRow,
  type AppPrincipal,
} from "./__tests__/fixtures";
import { createServer, initQuickdraw, type ServiceGrants } from "./index";
import { call, next, trustingAuth, transportHarness, v5Auth } from "./transports/__tests__/harness";
import { createProbe } from "./transports/__tests__/probe";

const harness = transportHarness();

afterEach(() => {
  vi.restoreAllMocks();
});

function services() {
  const probe = createProbe();
  return {
    probe,
    list: [qd.defineService(task, { methods: taskDefaults }), probe.service] as const,
  };
}

describe("close()", () => {
  it("disconnects every socket and resolves, once, without exiting the process", async () => {
    const exit = vi.spyOn(process, "exit").mockImplementation(() => undefined as never);
    const { server, url } = await harness.start({
      services: services().list,
      db,
      logger: captureLogger(),
      auth: trustingAuth,
    });
    const opened = harness.open(url, v5Auth(alice));
    await opened.hello;
    const disconnected = next(opened.socket, "disconnect");
    const closing = server.close();
    expect(server.close()).toBe(closing);
    await closing;
    expect(await disconnected).toBe("transport close");
    expect(server.httpServer.listening).toBe(false);
    expect(exit).not.toHaveBeenCalled();
  });

  it("closes the connections of HTTP calls still running after shutdownTimeoutMs", async () => {
    const { list, probe } = services();
    const { server, url } = await harness.start({
      services: list,
      db,
      logger: captureLogger(),
      auth: { authenticate: () => alice },
      shutdownTimeoutMs: 50,
    });
    const pending = fetch(`${url}/qd/probeService/wait`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: '{"key":"slow"}',
    }).catch((error: unknown) => error);
    await vi.waitFor(() => expect(probe.signals.has("slow")).toBe(true));
    const started = performance.now();
    await server.close();
    expect(performance.now() - started).toBeGreaterThanOrEqual(40);
    expect(await pending).toBeInstanceOf(Error);
    await vi.waitFor(() => expect(probe.signals.get("slow")?.aborted).toBe(true));
  });
});

describe("handleSignals", () => {
  const added = (signal: NodeJS.Signals, before: readonly unknown[]) =>
    process.listeners(signal).filter((listener) => !before.includes(listener));

  it("watches SIGTERM and SIGINT only when asked, closes on one, and never exits", async () => {
    const exit = vi.spyOn(process, "exit").mockImplementation(() => undefined as never);
    const before = { SIGTERM: process.listeners("SIGTERM"), SIGINT: process.listeners("SIGINT") };
    await harness.start({ services: services().list, db, logger: captureLogger() });
    expect(added("SIGTERM", before.SIGTERM)).toEqual([]);
    expect(added("SIGINT", before.SIGINT)).toEqual([]);

    const logger = captureLogger();
    const { server } = await harness.start({
      services: services().list,
      db,
      logger,
      handleSignals: true,
    });
    const [onTerm] = added("SIGTERM", before.SIGTERM);
    expect(added("SIGINT", before.SIGINT)).toHaveLength(1);
    (onTerm as (signal: NodeJS.Signals) => void)("SIGTERM");
    await vi.waitFor(() => expect(server.httpServer.listening).toBe(false));
    expect(added("SIGTERM", before.SIGTERM)).toEqual([]);
    expect(added("SIGINT", before.SIGINT)).toEqual([]);
    expect(logger.at("info").map((entry) => entry.message)).toContain(
      "Received SIGTERM; closing the quickdraw server",
    );
    expect(exit).not.toHaveBeenCalled();
  });
});

describe("rotate()", () => {
  it("tells every client to reconnect within the window", async () => {
    const { server, url } = await harness.start({
      services: services().list,
      db,
      logger: captureLogger(),
      auth: trustingAuth,
    });
    const opened = harness.open(url, v5Auth(alice));
    await opened.hello;
    const rotate = next(opened.socket, "qd:rotate");
    server.rotate({ withinMs: 5000 });
    expect(await rotate).toEqual({ withinMs: 5000 });
    expect(() => server.rotate({ withinMs: -1 })).toThrow(
      "rotate: withinMs must be a number of milliseconds, 0 or more",
    );
  });
});

describe("access.refresh()", () => {
  it("reloads a user's grants into their sockets and sends them qd:access", async () => {
    let grants: ServiceGrants | null = null;
    const { server, url } = await harness.start({
      services: services().list,
      db,
      logger: captureLogger(),
      auth: {
        ...trustingAuth,
        loadServiceAccess: (userId) => (userId === "alice" ? grants : null),
      },
    });
    const opened = harness.open(url, v5Auth(alice));
    await opened.hello;
    const other = harness.open(url, v5Auth(bob));
    await other.hello;
    const moderate = (socket: typeof opened.socket, id: number) =>
      call(socket, { id, s: "probeService", m: "moderate", i: { value: 2 } });
    expect(await moderate(opened.socket, 1)).toMatchObject({ ok: false, e: { code: "FORBIDDEN" } });

    grants = { probeService: "Moderate" };
    const pushed = next(opened.socket, "qd:access");
    const otherPushed = vi.fn();
    other.socket.on("qd:access", otherPushed);
    expect(await server.access.refresh("alice")).toEqual({ probeService: "Moderate" });
    expect(await pushed).toEqual({ serviceAccess: { probeService: "Moderate" } });
    expect(await moderate(opened.socket, 2)).toEqual({ ok: true, d: 4 });
    expect(await moderate(other.socket, 1)).toMatchObject({ ok: false, e: { code: "FORBIDDEN" } });
    expect(otherPushed).not.toHaveBeenCalled();
  });

  it("needs auth.loadServiceAccess", async () => {
    const { server } = await harness.start({
      services: services().list,
      db,
      logger: captureLogger(),
    });
    await expect(server.access.refresh("alice")).rejects.toThrow(
      "access.refresh needs auth.loadServiceAccess to reload a user's grants",
    );
  });
});

describe("the app's own Express app and HTTP server", () => {
  it("attaches to the HTTP server the app passes, and mounts the HTTP transport on its app", async () => {
    const app = express();
    app.use(express.json());
    const httpServer = createHttpServer(app);
    const { server, url } = await harness.start({
      services: services().list,
      db,
      logger: captureLogger(),
      app,
      httpServer,
    });
    expect(server.httpServer).toBe(httpServer);
    const response = await fetch(`${url}/qd/taskService/get`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: '{"id":"t1"}',
    });
    expect(await response.json()).toEqual({ ok: true, d: taskRow() });
    const opened = harness.open(url, v5Auth(null));
    expect((await opened.hello).protocol).toBe(5);
  });

  it("checks what it is given", () => {
    const base = { services: services().list, db, logger: captureLogger() };
    expect(() => createServer({ ...base, app: {} as never })).toThrow(
      "createServer: app must be an Express app",
    );
    expect(() => createServer({ ...base, httpServer: {} as never })).toThrow(
      "createServer: httpServer must be a Node HTTP server",
    );
    expect(() => createServer({ ...base, shutdownTimeoutMs: -1 })).toThrow(
      "createServer: shutdownTimeoutMs must be a whole number of milliseconds",
    );
  });
});

describe("qd.createServer", () => {
  it("makes the server's dispatcher the one qd.caller calls through", async () => {
    const app = initQuickdraw<{
      db: typeof db;
      principal: AppPrincipal;
      contracts: { task: typeof task };
    }>();
    const taskService = app.defineService(task, { methods: taskDefaults });
    const caller = app.caller(granted(alice, {}));
    await expect(caller.taskService.get({ id: "t1" })).rejects.toThrow(
      "qd.caller has no dispatcher to call through",
    );
    const server = app.createServer({ services: [taskService], db, logger: captureLogger() });
    try {
      expect(await caller.taskService.get({ id: "t1" })).toEqual(taskRow());
      expect(await server.dispatcher.caller(alice).taskService.get({ id: "t1" })).toEqual(
        taskRow(),
      );
    } finally {
      await server.close();
    }
  });
});
