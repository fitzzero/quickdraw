// The client connection against real servers (RFC 0003 sections 8.1 and
// 11.1): the v5 handshake, refusals for another protocol and for failed
// authentication, new credentials, `qd:access`, `qd:rotate`, retaining across
// a strict-mode remount, and backoff windows.

import { createServer as createHttpServer } from "node:http";
import type { AddressInfo } from "node:net";
import { Server } from "socket.io";
import { afterEach, describe, expect, it, vi } from "vitest";
import { QUICKDRAW_VERSION, type ProtocolMismatch } from "../index";
import { captureLogger, tick } from "../server/__tests__/fixtures";
import { callData } from "./call";
import { createQuickdrawConnection } from "./connection";
import { reloadOncePerSession, RELOAD_KEY_PREFIX } from "./reload";
import { alice, bob, clientHarness, testAuth, until, whenStatus } from "./__tests__/fixtures";

const harness = clientHarness();

const echo = { service: "probeService", method: "echo", input: { text: "who" } } as const;

async function caller(connection: Parameters<typeof callData>[0]): Promise<unknown> {
  const reply = await callData<{ readonly userId: unknown }>(connection, echo);
  return reply.userId;
}

/** A Socket.IO server that refuses every handshake as a server of protocol 6 would. */
async function protocolSixServer(): Promise<{ readonly url: string; close(): Promise<void> }> {
  const httpServer = createHttpServer();
  const io = new Server(httpServer);
  io.use((_socket, next) => {
    const error = new Error("This server speaks quickdraw protocol 6") as Error & {
      data?: unknown;
    };
    error.data = { code: "PROTOCOL_MISMATCH", expected: 6 };
    next(error);
  });
  await new Promise<void>((resolve) => {
    httpServer.listen(0, "127.0.0.1", resolve);
  });
  const { port } = httpServer.address() as AddressInfo;
  return {
    url: `http://127.0.0.1:${port}`,
    close: () =>
      new Promise((resolve) => {
        void io.close(() => {
          resolve();
        });
      }),
  };
}

describe("createQuickdrawConnection", () => {
  it("connects with the v5 handshake beside the credentials, and keeps the server's hello", async () => {
    const handshakes: unknown[] = [];
    const { app } = await harness.start({
      auth: {
        authenticate: (request) => {
          handshakes.push(request.auth);
          return testAuth.authenticate?.(request);
        },
      },
    });
    const connection = harness.connection(app.url, { auth: "carol" });
    const statuses: string[] = [];
    connection.subscribe(() => {
      statuses.push(connection.getState().status);
    });
    expect(connection.getState()).toMatchObject({ status: "idle", hello: null, refusal: null });
    connection.open();
    await whenStatus(connection, "connected");
    expect(handshakes).toEqual([
      { token: "carol", qd: { protocol: 5, client: QUICKDRAW_VERSION } },
    ]);
    await until(() => connection.getState().hello !== null);
    expect(connection.getState().hello).toMatchObject({
      protocol: 5,
      server: QUICKDRAW_VERSION,
      limits: { maxInFlightQueries: 16 },
      features: [],
    });
    expect(statuses.slice(0, 2)).toEqual(["connecting", "connected"]);
    expect(await caller(connection)).toBe("carol");
  });

  it("calls onProtocolMismatch when the server speaks another protocol, and does not retry", async () => {
    const server = await protocolSixServer();
    try {
      const onProtocolMismatch = vi.fn();
      const connection = harness.connection(server.url, { onProtocolMismatch });
      connection.open();
      await whenStatus(connection, "refused");
      const mismatch: ProtocolMismatch = { code: "PROTOCOL_MISMATCH", expected: 6 };
      expect(connection.getState().refusal).toEqual(mismatch);
      expect(onProtocolMismatch).toHaveBeenCalledWith(mismatch);
      expect(connection.socket.active).toBe(false);
      await tick(200);
      expect(onProtocolMismatch).toHaveBeenCalledTimes(1);
      expect(connection.getState().status).toBe("refused");
    } finally {
      await server.close();
    }
  });

  it("is refused with UNAUTHENTICATED, not a protocol mismatch, when authentication fails", async () => {
    const { app } = await harness.start({
      auth: {
        authenticate: () => {
          throw new Error("the session expired");
        },
      },
      logger: captureLogger(),
    });
    const onProtocolMismatch = vi.fn();
    const connection = harness.connection(app.url, { onProtocolMismatch });
    connection.open();
    await whenStatus(connection, "refused");
    expect(connection.getState().refusal).toEqual({ code: "UNAUTHENTICATED" });
    expect(onProtocolMismatch).not.toHaveBeenCalled();
  });

  it("reconnects with new credentials, and only when they change", async () => {
    const { app } = await harness.start();
    const connection = await harness.connect(app.url, {
      auth: { principal: { userId: "alice", kind: "user" } },
    });
    expect(await caller(connection)).toBe("alice");
    const first = connection.socket.id;
    connection.setAuth({ principal: { kind: "user", userId: "alice" } });
    expect(connection.getState().status).toBe("connected");
    connection.setAuth({ principal: bob });
    expect(connection.getState().status).toBe("connecting");
    await whenStatus(connection, "connected");
    expect(connection.socket.id).not.toBe(first);
    expect(await caller(connection)).toBe("bob");
    connection.setAuth("dave");
    await whenStatus(connection, "connected");
    expect(await caller(connection)).toBe("dave");
    connection.setAuth(null);
    await whenStatus(connection, "connected");
    expect(await caller(connection)).toBeNull();
  });

  it("keeps the grants from the hello and from qd:access, and drops them with the credentials", async () => {
    const grants = new Map<string, Record<string, "Read" | "Moderate">>([
      ["alice", { probeService: "Read" }],
    ]);
    const { app } = await harness.start({
      auth: { ...testAuth, loadServiceAccess: (userId) => grants.get(userId) },
    });
    const connection = harness.connection(app.url);
    expect(connection.getState().serviceAccess).toBeNull();
    connection.open();
    await until(() => connection.getState().hello !== null);
    expect(connection.getState().hello?.userId).toBe("alice");
    expect(connection.getState().serviceAccess).toEqual({ probeService: "Read" });
    grants.set("alice", { probeService: "Moderate" });
    await app.server.access.refresh("alice");
    await until(() => connection.getState().serviceAccess?.probeService === "Moderate");
    connection.setAuth({ principal: bob });
    expect(connection.getState()).toMatchObject({ hello: null, serviceAccess: null });
    await until(() => connection.getState().hello !== null);
    expect(connection.getState()).toMatchObject({ hello: { userId: "bob" }, serviceAccess: {} });
  });

  it("waits the server's time limit plus 2 s once the hello says it, unless timeoutMs was given", async () => {
    const { app } = await harness.start();
    const connection = harness.connection(app.url);
    expect(connection.timeoutMs).toBe(10_000);
    connection.open();
    await until(() => connection.getState().hello !== null);
    expect(connection.getState().hello?.limits.callTimeoutMs).toBe(30_000);
    expect(connection.timeoutMs).toBe(32_000);
    const fixed = await harness.connect(app.url, { timeoutMs: 1500 });
    await until(() => fixed.getState().hello !== null);
    expect(fixed.timeoutMs).toBe(1500);
  });

  it("is reconnecting while a dropped socket comes back, rejoins its topics, and tells onReconnect", async () => {
    const { app } = await harness.start();
    const connection = await harness.connect(app.url);
    const reconnects = vi.fn();
    const stop = connection.onReconnect(reconnects);
    const seen: boolean[] = [];
    connection.subscribe(() => {
      seen.push(connection.getState().reconnecting);
    });
    const first = connection.socket.id;
    app.server.rotate({ withinMs: 0 });
    await until(
      () => connection.socket.id !== first && connection.getState().status === "connected",
    );
    expect(seen).toContain(true);
    expect(connection.getState().reconnecting).toBe(false);
    expect(reconnects).toHaveBeenCalledTimes(1);
    connection.setAuth({ principal: bob });
    expect(connection.getState()).toMatchObject({ status: "connecting", reconnecting: false });
    await whenStatus(connection, "connected");
    expect(reconnects).toHaveBeenCalledTimes(1);
    stop();
    const second = connection.socket.id;
    app.server.rotate({ withinMs: 0 });
    await until(
      () => connection.socket.id !== second && connection.getState().status === "connected",
    );
    expect(reconnects).toHaveBeenCalledTimes(1);
  });

  it("reconnects within the window a qd:rotate frame gives", async () => {
    const { app } = await harness.start();
    const connection = await harness.connect(app.url);
    const first = connection.socket.id;
    const statuses: string[] = [];
    connection.subscribe(() => {
      statuses.push(connection.getState().status);
    });
    app.server.rotate({ withinMs: 100 });
    await until(
      () => connection.socket.id !== first && connection.getState().status === "connected",
      2000,
    );
    expect(statuses).toContain("connecting");
    expect(statuses).not.toContain("disconnected");
    expect(await caller(connection)).toBe(alice.userId);
  });

  it("keeps its socket through a release and retain in one tick, and closes a tick after the last release", async () => {
    const { app } = await harness.start();
    const sockets = new Set<string>();
    app.server.io.on("connection", (socket) => {
      sockets.add(socket.id);
    });
    const connection = harness.connection(app.url);
    const release = connection.retain();
    await whenStatus(connection, "connected");
    const id = connection.socket.id;
    release();
    const again = connection.retain();
    await tick(50);
    expect(connection.getState().status).toBe("connected");
    expect(connection.socket.id).toBe(id);
    again();
    again();
    expect(connection.getState().status).toBe("connected");
    await whenStatus(connection, "idle");
    expect(connection.socket.connected).toBe(false);
    expect(sockets.size).toBe(1);
  });

  it("ends a backoff window on its own, never shortens one, and clears them on close", async () => {
    const { app } = await harness.start();
    const connection = await harness.connect(app.url);
    connection.reportRateLimited("subscription", 250);
    expect(connection.getState().backoff.subscription).toBeGreaterThan(Date.now());
    await until(() => connection.getState().backoff.subscription === undefined, 1000);
    expect(connection.backoffRemaining("subscription")).toBe(0);
    connection.reportRateLimited("query", 2000);
    const ends = connection.getState().backoff.query;
    connection.reportRateLimited("query", 250);
    expect(connection.getState().backoff.query).toBe(ends);
    connection.close();
    expect(connection.getState()).toMatchObject({ status: "idle", backoff: {} });
  });

  it("refuses a missing url or a time limit that is not a positive number", () => {
    expect(() => createQuickdrawConnection({ url: "" })).toThrow(TypeError);
    for (const timeoutMs of [0, -1, Number.NaN, Number.POSITIVE_INFINITY, 2 ** 31]) {
      expect(() => createQuickdrawConnection({ url: "http://x", timeoutMs })).toThrow(
        "timeoutMs must be a number of milliseconds",
      );
    }
  });
});

describe("reloadOncePerSession", () => {
  const mismatch = (expected: number): ProtocolMismatch => ({
    code: "PROTOCOL_MISMATCH",
    expected,
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("does nothing without a DOM", () => {
    expect(globalThis).not.toHaveProperty("location");
    expect(() => {
      reloadOncePerSession(mismatch(6));
    }).not.toThrow();
  });

  it("reloads the page once per browser session and server protocol", () => {
    const reload = vi.fn();
    const stored = new Map<string, string>();
    vi.stubGlobal("location", { reload });
    vi.stubGlobal("sessionStorage", {
      getItem: (key: string) => stored.get(key) ?? null,
      setItem: (key: string, value: string) => stored.set(key, value),
    });
    reloadOncePerSession(mismatch(6));
    reloadOncePerSession(mismatch(6));
    expect(reload).toHaveBeenCalledTimes(1);
    expect([...stored.keys()]).toEqual([`${RELOAD_KEY_PREFIX}6`]);
    reloadOncePerSession(mismatch(7));
    expect(reload).toHaveBeenCalledTimes(2);
  });

  it("does not reload when it cannot record the reload", () => {
    const reload = vi.fn();
    vi.stubGlobal("location", { reload });
    vi.stubGlobal("sessionStorage", {
      getItem: () => {
        throw new Error("storage is disabled");
      },
      setItem: () => undefined,
    });
    reloadOncePerSession(mismatch(6));
    expect(reload).not.toHaveBeenCalled();
  });
});
