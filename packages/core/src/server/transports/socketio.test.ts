// The Socket.IO transport over real connections (RFC 0003 sections 8 and 10):
// the v5 call round trip, every error code, cancellation, the fixed listener
// set, reply sizes, and the registration hook later packs add listeners with.

import { createServer as createHttpServer } from "node:http";
import type { AddressInfo } from "node:net";
import { describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { ERROR_CODES, QUICKDRAW_VERSION, defineContract, listOf, query } from "../../index";
import {
  alice,
  bob,
  captureLogger,
  db,
  deferred,
  granted,
  qd,
  task,
  taskDefaults,
  taskRow,
  tick,
} from "../__tests__/fixtures";
import { createDispatcher } from "../dispatcher";
import type { AnyService, CallRecord, PipelineOptions, ServerOnlyOptions } from "../index";
import type { AppPrincipal } from "../__tests__/fixtures";
import { call, next, trustingAuth, transportHarness, v5Auth } from "./__tests__/harness";
import { createProbe } from "./__tests__/probe";
import { createSocketServer } from "./socketServer";

const harness = transportHarness();

async function serve(extra: ServerOnlyOptions<AppPrincipal> & PipelineOptions = {}) {
  const probe = createProbe();
  const logger = captureLogger();
  const records: CallRecord[] = [];
  const { server, url } = await harness.start({
    services: [qd.defineService(task, { methods: taskDefaults }), probe.service],
    db,
    logger,
    auth: trustingAuth,
    onCall: (record) => records.push(record),
    ...extra,
  });
  return { server, url, probe, logger, records };
}

async function connect(url: string, principal: AppPrincipal | null = alice) {
  const opened = harness.open(url, v5Auth(principal));
  await opened.connected;
  await opened.hello;
  return opened.socket;
}

describe("a v5 call", () => {
  it("is answered with its data, after a hello that announces the server's limits", async () => {
    const { url, records } = await serve({
      limits: { maxInFlightQueries: 4, callTimeoutMs: 5000, subscriptions: { maxQueued: 32 } },
    });
    const opened = harness.open(url, v5Auth(alice));
    await opened.connected;
    expect(await opened.hello).toEqual({
      protocol: 5,
      server: QUICKDRAW_VERSION,
      serverId: expect.any(String),
      limits: {
        maxInFlightQueries: 4,
        maxQueuedQueries: 64,
        maxSubscribeIds: 500,
        callTimeoutMs: 5000,
        subscriptions: { maxInFlight: 8, maxQueued: 32 },
      },
      features: [],
      userId: "alice",
      serviceAccess: {},
    });
    const reply = await call(opened.socket, { id: 1, s: "taskService", m: "get", i: { id: "t1" } });
    expect(reply).toEqual({ ok: true, d: taskRow() });
    expect(
      await call(opened.socket, { id: 2, s: "probeService", m: "echo", i: { text: "hi" } }),
    ).toEqual({ ok: true, d: { text: "hi", userId: "alice", transport: "socket", grants: null } });
    // The first acknowledgement of the socket is packet 0: `30[reply]`.
    expect(records[0]).toMatchObject({ transport: "socket", outcome: "ok" });
    expect(records[0]?.bytes).toBe(Buffer.byteLength(`30${JSON.stringify([reply])}`));
  });

  it("delivers every error code a handler throws, with its message and data", async () => {
    const { url } = await serve();
    const socket = await connect(url);
    for (const [id, code] of ERROR_CODES.entries()) {
      const expected =
        code === "INTERNAL"
          ? { code, message: "Internal error" }
          : code === "RATE_LIMITED"
            ? { code, message: `Failed with ${code}`, data: { retryAfterMs: 1500 } }
            : { code, message: `Failed with ${code}` };
      expect(await call(socket, { id, s: "probeService", m: "fail", i: { code } })).toEqual({
        ok: false,
        e: expected,
      });
    }
  });

  it("answers a code outside ERROR_CODES as INTERNAL, and records it so", async () => {
    const { url, records, logger } = await serve();
    const socket = await connect(url);
    expect(
      await call(socket, { id: 1, s: "probeService", m: "failOddly", i: { code: 404 } }),
    ).toEqual({ ok: false, e: { code: "INTERNAL", message: "Internal error" } });
    expect(records.map((record) => record.outcome)).toEqual(["INTERNAL"]);
    expect(logger.at("error")[0]?.meta?.error).toMatchObject({
      code: "INTERNAL",
      cause: { name: "QuickdrawError", code: 404, message: "Failed with 404" },
    });
  });

  it("carries the pipeline's own failures: unknown names, invalid input, no principal, no grant", async () => {
    const { url } = await serve();
    const socket = await connect(url);
    const anonymous = await connect(url, null);
    expect(await call(socket, { id: 1, s: "chatService", m: "get" })).toEqual({
      ok: false,
      e: { code: "NOT_FOUND", message: 'Unknown service "chatService"' },
    });
    expect(
      await call(socket, { id: 2, s: "taskService", m: "rename", i: { id: 7 } }),
    ).toMatchObject({
      ok: false,
      e: {
        code: "VALIDATION",
        data: { issues: [{ path: ["id"] }, { path: ["title"] }] },
      },
    });
    expect(await call(anonymous, { id: 1, s: "probeService", m: "wait", i: { key: "x" } })).toEqual(
      { ok: false, e: { code: "UNAUTHENTICATED", message: "Authentication required" } },
    );
    expect(
      await call(socket, { id: 3, s: "probeService", m: "moderate", i: { value: 1 } }),
    ).toEqual({ ok: false, e: { code: "FORBIDDEN", message: "Insufficient permissions" } });
  });

  it("answers a malformed frame or a reused id with VALIDATION, and ignores a call without an ack", async () => {
    const { url, probe } = await serve();
    const socket = await connect(url);
    expect(await call(socket, { s: "taskService", m: "get" })).toEqual({
      ok: false,
      e: {
        code: "VALIDATION",
        message: "A qd:call frame needs { id, s, m, i?, v? } and an acknowledgement",
        data: {
          issues: [
            {
              path: [],
              message: "A qd:call frame needs { id, s, m, i?, v? } and an acknowledgement",
            },
          ],
        },
      },
    });
    socket.emit("qd:call", { id: 9, s: "probeService", m: "wait", i: { key: "unacked" } });
    const first = call(socket, { id: 7, s: "probeService", m: "wait", i: { key: "first" } });
    await vi.waitFor(() => expect(probe.gates.has("first")).toBe(true));
    expect(
      await call(socket, { id: 7, s: "taskService", m: "get", i: { id: "t1" } }),
    ).toMatchObject({
      ok: false,
      e: {
        code: "VALIDATION",
        message: "Call 7 is already in flight on this socket",
        data: { issues: [{ path: ["id"] }] },
      },
    });
    probe.gates.get("first")?.resolve("done");
    expect(await first).toEqual({ ok: true, d: "done" });
    expect(await call(socket, { id: 7, s: "taskService", m: "get", i: { id: "t1" } })).toEqual({
      ok: true,
      d: taskRow(),
    });
    expect(probe.gates.has("unacked")).toBe(false);
  });
});

describe("cancellation", () => {
  it("aborts the handler's signal on qd:cancel, and the acknowledgement still arrives", async () => {
    const { url, probe, records } = await serve();
    const socket = await connect(url);
    const pending = call(socket, { id: 3, s: "probeService", m: "wait", i: { key: "a" } });
    await vi.waitFor(() => expect(probe.signals.has("a")).toBe(true));
    socket.emit("qd:cancel", { id: 99 });
    socket.emit("qd:cancel", { nope: true });
    socket.emit("qd:cancel", { id: 3 });
    expect(await pending).toEqual({
      ok: false,
      e: { code: "CANCELLED", message: "The call was cancelled" },
    });
    expect(probe.signals.get("a")?.aborted).toBe(true);
    expect(records.map((record) => record.outcome)).toEqual(["CANCELLED"]);
  });

  it("aborts every call of a socket that disconnects", async () => {
    const { url, probe } = await serve();
    const socket = await connect(url);
    void call(socket, { id: 1, s: "probeService", m: "wait", i: { key: "b" } }).catch(() => null);
    await vi.waitFor(() => expect(probe.signals.has("b")).toBe(true));
    socket.disconnect();
    await vi.waitFor(() => expect(probe.signals.get("b")?.aborted).toBe(true));
  });
});

/** A service with `count` queries `m0`, `m1`, ... */
function serviceWith(count: number): AnyService {
  const shape = query({ input: z.undefined(), output: z.number() });
  const names = Array.from({ length: count }, (_, index) => `m${index}`);
  const contract = defineContract(`wide${count}Service`, {
    methods: Object.fromEntries(names.map((name) => [name, shape])),
  });
  const methods = Object.fromEntries(
    names.map((name) => [name, { access: "public", handler: () => 1 }]),
  );
  return qd.defineService(contract, { methods } as never) as AnyService;
}

describe("listeners per socket", () => {
  it("are the same few for a server with 2 methods and one with 200", async () => {
    const counts: number[] = [];
    for (const service of [serviceWith(2), serviceWith(200)]) {
      const { server, url } = await harness.start({ services: [service], logger: captureLogger() });
      const socket = await connect(url);
      const serverSocket = server.io.sockets.sockets.get(socket.id ?? "");
      // "error" is Socket.IO's own no-op listener, on every socket; entity
      // and collection subscriptions, change topics, channels and streams
      // add one listener per event, whatever the services.
      expect(serverSocket?.eventNames()).toEqual([
        "error",
        "qd:call",
        "qd:cancel",
        "disconnect",
        "qd:sub",
        "qd:unsub",
        "qd:col:sub",
        "qd:col:items",
        "qd:col:unsub",
        "qd:watch",
        "qd:unwatch",
        "qd:ch",
        "qd:stream:sub",
        "qd:stream:unsub",
      ]);
      counts.push(serverSocket?.eventNames().length ?? 0);
      expect(await call(socket, { id: 1, s: service.name, m: "m1" })).toEqual({ ok: true, d: 1 });
    }
    expect(counts).toEqual([14, 14]);
  });
});

describe("replies that cannot be encoded", () => {
  it.each([
    ["the JSON parser", false],
    ["the stock parser", true],
  ])("are answered with INTERNAL through %s", async (_label, binary) => {
    const { url, logger } = await serve({ binary });
    const socket = await connect(url);
    expect(await call(socket, { id: 1, s: "probeService", m: "unencodable" })).toEqual({
      ok: false,
      e: { code: "INTERNAL", message: "Internal error" },
    });
    expect(logger.at("error").map((entry) => entry.message)).toContain(
      "A call's reply could not be encoded; it was answered with INTERNAL",
    );
    expect(await call(socket, { id: 2, s: "taskService", m: "get", i: { id: "t1" } })).toEqual({
      ok: true,
      d: taskRow(),
    });
  });

  it("are measured only by the JSON parser: the stock parser reports no size", async () => {
    const { url, records } = await serve({ binary: true });
    const opened = harness.open(url, v5Auth(alice));
    expect((await opened.hello).features).toEqual(["binary"]);
    await call(opened.socket, { id: 1, s: "taskService", m: "get", i: { id: "t1" } });
    expect(records.map((record) => [record.outcome, record.bytes])).toEqual([["ok", 0]]);
  });
});

describe("a shared run's reply", () => {
  const SENTINEL = "a board only a shared run returns";
  const boardRow = z.object({ id: z.string(), title: z.string(), notes: z.string() });
  const board = defineContract("boardService", {
    entity: boardRow,
    fields: { notes: "Admin" },
    methods: {
      board: query({ input: z.object({ projectId: z.string() }), output: listOf("entity") }),
    },
  });
  const rows = [
    { id: "b1", title: SENTINEL, notes: "admins only" },
    { id: "b2", title: SENTINEL, notes: "admins only" },
  ];
  const readerRows = rows.map(({ notes: _notes, ...row }) => row);

  /** A server whose `board` query shares one run, held until `gate` opens, kept for a minute after. */
  async function serveBoard() {
    const gate = deferred();
    const runs = { n: 0 };
    const service = qd.defineService(board, {
      methods: {
        board: {
          access: "authenticated",
          share: "all",
          ttlMs: 60_000,
          handler: async () => {
            runs.n += 1;
            await gate.promise;
            return rows;
          },
        },
      },
    });
    const records: CallRecord[] = [];
    const { url } = await harness.start({
      services: [service],
      db,
      logger: captureLogger(),
      auth: trustingAuth,
      onCall: (record) => records.push(record),
    });
    return { url, gate, runs, records };
  }

  /** Calls `board` from every principal at once, opens the run, and counts the encodings of its rows. */
  async function callTogether(principals: readonly AppPrincipal[]) {
    const { url, gate, runs, records } = await serveBoard();
    const sockets = await Promise.all(principals.map(async (who) => await connect(url, who)));
    const stringify = vi.spyOn(JSON, "stringify");
    try {
      const replies = Promise.all(
        sockets.map(
          async (socket) =>
            await call(socket, { id: 1, s: "boardService", m: "board", i: { projectId: "p1" } }),
        ),
      );
      await vi.waitFor(() => {
        expect(runs.n).toBe(1);
      });
      // Calls that arrive after the run settled join it too, through `ttlMs`.
      await tick(20);
      gate.resolve();
      const results = await replies;
      const encodings = stringify.mock.results.filter(
        (result) => typeof result.value === "string" && result.value.includes(SENTINEL),
      ).length;
      return { results, encodings, runs: runs.n, records };
    } finally {
      stringify.mockRestore();
    }
  }

  it("is encoded once for every caller who sees the same fields, not once per caller", async () => {
    const readers = [alice, bob, alice, bob, alice, bob];
    const { results, encodings, runs, records } = await callTogether(readers);
    expect(runs).toBe(1);
    expect(encodings).toBe(1);
    expect(results).toEqual(readers.map(() => ({ ok: true, d: readerRows })));
    expect(records.filter((record) => record.shared)).toHaveLength(readers.length - 1);
    // Each socket's first acknowledgement is packet 0: `30[reply]`, measured as before.
    const bytes = Buffer.byteLength(`30${JSON.stringify([{ ok: true, d: readerRows }])}`);
    expect(records.map((record) => record.bytes)).toEqual(readers.map(() => bytes));
  });

  it("never hands a joiner the copy of a level above its own", async () => {
    const admin = granted(alice, { boardService: "Admin" });
    const reader = granted(bob, { boardService: "Read" });
    const callers = [reader, admin, reader, admin];
    const { results, encodings, runs } = await callTogether(callers);
    expect(runs).toBe(1);
    // One copy, stripped and encoded once, per group of callers who see the same fields.
    expect(encodings).toBe(2);
    expect(results).toEqual([
      { ok: true, d: readerRows },
      { ok: true, d: rows },
      { ok: true, d: readerRows },
      { ok: true, d: rows },
    ]);
  });
});

describe("a socket's principal", () => {
  it("is named in the socket's hello, with its grants", async () => {
    const { url } = await serve({
      auth: {
        ...trustingAuth,
        loadServiceAccess: (userId) => (userId === "bob" ? { taskService: "Admin" } : undefined),
      },
    });
    const hellos = await Promise.all(
      [alice, bob, null].map(async (principal) => await harness.open(url, v5Auth(principal)).hello),
    );
    expect(hellos.map(({ userId, serviceAccess }) => ({ userId, serviceAccess }))).toEqual([
      { userId: "alice", serviceAccess: {} },
      { userId: "bob", serviceAccess: { taskService: "Admin" } },
      { userId: null, serviceAccess: {} },
    ]);
    const carried = await harness.open(
      url,
      v5Auth({ ...alice, serviceAccess: { taskService: "Read" } }),
    ).hello;
    expect(carried.serviceAccess).toEqual({ taskService: "Read" });
  });

  it("joins the user's room, and anonymous sockets join none", async () => {
    const { server, url } = await serve();
    await connect(url, alice);
    await connect(url, null);
    const inRoom = await server.io.in("user:alice").fetchSockets();
    expect(inRoom.map((socket) => socket.data.principal)).toEqual([alice]);
    const all = await server.io.fetchSockets();
    expect(all.map((socket) => socket.data.principal)).toEqual([alice, null]);
    expect(all.map((socket) => socket.data.protocol)).toEqual([5, 5]);
  });
});

describe("the registration hook for later listeners", () => {
  it("adds an extension's listeners to every v5 socket, with the transport's context", async () => {
    const logger = captureLogger();
    const dispatcher = createDispatcher({ services: [], logger });
    const httpServer = createHttpServer();
    const contexts: unknown[] = [];
    const { io } = createSocketServer(httpServer, {
      dispatcher,
      logger,
      resolvePrincipal: () => Promise.resolve(alice),
      loadServiceAccess: undefined,
      binary: false,
      legacyWire: undefined,
      cors: undefined,
      socket: undefined,
      rateLimit: false,
      extensions: [
        (socket, context) => {
          contexts.push(context.dispatcher);
          socket.on("qd:watch", (frame: unknown, ack: (reply: unknown) => void) => {
            ack({ ok: true, frame });
          });
        },
      ],
    });
    await new Promise<void>((resolve) => {
      httpServer.listen(0, "127.0.0.1", resolve);
    });
    try {
      const { port } = httpServer.address() as AddressInfo;
      const opened = harness.open(`http://127.0.0.1:${port}`, v5Auth(alice));
      const hello = await opened.hello;
      expect(hello.protocol).toBe(5);
      const reply: unknown = await opened.socket
        .timeout(2000)
        .emitWithAck("qd:watch", { s: "taskService", topic: "byProject:p1" });
      expect(reply).toEqual({ ok: true, frame: { s: "taskService", topic: "byProject:p1" } });
      expect(contexts).toEqual([dispatcher]);
      const serverSocket = io.sockets.sockets.get(opened.socket.id ?? "");
      expect(serverSocket?.eventNames()).toEqual([
        "error",
        "qd:call",
        "qd:cancel",
        "disconnect",
        "qd:watch",
      ]);
      const changed = next(opened.socket, "qd:changed");
      io.emit("qd:changed", { s: "taskService", topic: "byProject:p1" });
      expect(await changed).toEqual({ s: "taskService", topic: "byProject:p1" });
    } finally {
      await io.close();
    }
  });
});
