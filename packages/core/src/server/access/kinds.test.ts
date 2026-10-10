// Declared principal kinds (RFC 0003 section 4.1, `kinds.ts`) through a real
// server against PGlite, on the access tests' board. The app admits users
// and agents (`initQuickdraw({ kinds })`). Its token service has no model:
// any of them may beat, only a user may mint. Its task service is for users
// alone, so an agent's token acting for Ada, who owns P1 and so every row
// here, is refused by every method and subscription of it, and its channel
// messages are dropped, while Ada herself passes. No grant gets past the
// check, an anonymous caller is left to the access form, and a principal
// without a kind, or of a kind the app never admitted, is refused everywhere.

import { io, type Socket } from "socket.io-client";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { z } from "zod";
import type { PrismaClient } from "../../../test/prisma/setup";
import { defineContract, mutation, query } from "../../index";
import { createHarness, type Harness } from "../../prisma/__tests__/harness";
import {
  createTestApp,
  describeAccessMatrix,
  emitWithAck,
  type TestApp,
} from "../../testing/index";
import { inherit, initQuickdraw, type Principal } from "../index";
import { createMcpRegistry } from "../mcp/index";
import { isPrincipal } from "../transports/auth";
import { projectContract, projectService, seedBoard, type Board } from "./__tests__/board";

const qd = initQuickdraw<{ db: PrismaClient; principal: Principal }>({ kinds: ["user", "agent"] });

const taskContract = defineContract("taskService", {
  entity: z.object({ id: z.string(), projectId: z.string(), title: z.string() }),
  methods: {
    get: query({ input: z.object({ id: z.string() }), output: "entity" }),
    ping: query({ input: z.undefined(), output: z.literal("pong") }),
  },
  collections: { byProject: { scope: "projectId", item: "entity", order: [["id", "asc"]] } },
  streams: {
    logs: { item: z.string(), scope: "taskId", access: { entry: "Read" } },
    ticks: { item: z.number(), access: "public" },
  },
  channels: { wave: { payload: z.object({ n: z.number() }) } },
});

const tokenContract = defineContract("tokenService", {
  methods: {
    mint: mutation({ input: z.object({ label: z.string() }), output: z.string() }),
    heartbeat: mutation({ input: z.undefined(), output: z.string() }),
  },
});

/** The `wave` messages that reached the handler. */
const waves: { readonly userId: string; readonly n: number }[] = [];

const taskService = qd.defineService(taskContract, {
  model: "task",
  access: inherit({ from: projectContract, via: "projectId" }),
  kinds: ["user"],
  watchAccess: "authenticated",
  collections: { byProject: { anchor: projectContract } },
  methods: {
    get: {
      access: { entry: "Read" },
      handler: ({ input, db }) => db.task.findUniqueOrThrow({ where: { id: input.id } }),
    },
    ping: { access: "public", handler: () => "pong" as const },
  },
  channels: {
    wave: (payload, ctx) => {
      waves.push({ userId: ctx.principal.userId, n: payload.n });
    },
  },
});

const tokenService = qd.defineService(tokenContract, {
  methods: {
    mint: {
      access: "authenticated",
      kinds: ["user"],
      handler: ({ input }) => `token:${input.label}`,
    },
    heartbeat: { access: "authenticated", handler: ({ ctx }) => String(ctx.principal.kind) },
  },
});

let h: Harness;
let board: Board;
const apps: TestApp[] = [];
const sockets: Socket[] = [];

beforeAll(async () => {
  h = await createHarness();
}, 60_000);

afterAll(async () => {
  await h.close();
});

beforeEach(async () => {
  await h.database.reset();
  board = await seedBoard(h.prisma);
  waves.length = 0;
});

afterEach(async () => {
  for (const socket of sockets.splice(0)) {
    socket.disconnect();
  }
  await Promise.all(apps.splice(0).map(async (app) => await app.close()));
});

/** Ada, her agent's token, the token with Admin grants on both services, and two the app never admits. */
function principals() {
  const user: Principal = { userId: board.ada, kind: "user" };
  const agent: Principal = { userId: board.ada, kind: "agent" };
  const admin: Principal = {
    ...agent,
    serviceAccess: { taskService: "Admin", tokenService: "Admin" },
  };
  const runner: Principal = { userId: board.ada, kind: "runner" };
  const kindless: Principal = { userId: board.ada };
  return { user, agent, admin, runner, kindless };
}

/** The app: a socket's principal is the one its handshake names; an HTTP call's, its bearer token's. */
async function start() {
  const app = await createTestApp({
    services: [projectService, taskService, tokenService],
    db: h.db,
    legacyWire: true,
    auth: {
      authenticate: ({ auth }) => {
        if (isPrincipal(auth.principal)) {
          return auth.principal;
        }
        const named = principals();
        return auth.token === "agent" ? named.agent : auth.token === "user" ? named.user : null;
      },
    },
  });
  apps.push(app as unknown as TestApp);
  return app;
}

type App = Awaited<ReturnType<typeof start>>;

/** A 4.x client acting as `principal`: `auth` without `qd`, so the legacy shim serves it. */
async function legacyClient(app: App, principal: Principal): Promise<Socket> {
  const socket = io(app.url, {
    forceNew: true,
    reconnection: false,
    transports: ["websocket"],
    auth: { principal },
  });
  sockets.push(socket);
  await new Promise<void>((resolve, reject) => {
    socket.once("connect", resolve);
    socket.once("connect_error", reject);
  });
  return socket;
}

/** Waits until the server handled every event the socket sent before: its acknowledgement comes after them. */
async function settle(socket: Socket): Promise<void> {
  await emitWithAck(socket, "qd:unsub", { s: "noService", ids: [] });
}

/** What a refused principal gets, from the method or service `what` names. */
function refused(what: string, kind: string | undefined) {
  return {
    code: "FORBIDDEN",
    message:
      kind === undefined
        ? `${what} is not open to a principal without a kind`
        : `${what} is not open to principals of kind "${kind}"`,
  };
}

describe("a method's kinds", () => {
  it("refuses an agent on every transport, whatever its grants, and leaves an anonymous caller to the form", async () => {
    const app = await start();
    const { user, agent, admin } = principals();
    const mint = { label: "ci" };
    const refusal = refused("tokenService.mint", "agent");
    expect(await app.as(user).tokenService.mint(mint)).toBe("token:ci");
    await expect(app.as(agent).tokenService.mint(mint)).rejects.toMatchObject(refusal);
    // A service-wide Admin grant passes every form, but not the kind.
    await expect(app.as(admin).tokenService.mint(mint)).rejects.toMatchObject(refusal);
    await expect(app.as(null).tokenService.mint(mint)).rejects.toMatchObject({
      code: "UNAUTHENTICATED",
    });
    // The method beside it keeps the app's list, which admits agents.
    expect(await app.as(agent).tokenService.heartbeat()).toBe("agent");

    // Over a socket.
    const socket = await app.connect(agent);
    await expect(socket.call.tokenService.mint(mint)).rejects.toMatchObject(refusal);
    expect(await socket.call.tokenService.heartbeat()).toBe("agent");

    // Over HTTP.
    const post = (token: string) =>
      fetch(`${app.url}/qd/tokenService/mint`, {
        method: "POST",
        headers: { "content-type": "application/json", authorization: `Bearer ${token}` },
        body: JSON.stringify(mint),
      });
    const byAgent = await post("agent");
    expect(byAgent.status).toBe(403);
    expect(await byAgent.json()).toEqual({ ok: false, e: refusal });
    expect(await (await post("user")).json()).toEqual({ ok: true, d: "token:ci" });

    // Through the MCP bridge.
    const registry = createMcpRegistry({
      services: [tokenService],
      dispatcher: app.server.dispatcher,
      principal: () => agent,
    });
    const request = { transport: "stdio", sessionId: "s1" } as const;
    expect(await registry.call("tokenService_mint", mint, { request })).toMatchObject({
      ok: false,
      error: refusal,
    });

    // Through the 4.x shim.
    const legacy = await legacyClient(app, agent);
    expect(await legacy.timeout(2000).emitWithAck("tokenService:mint", mint)).toEqual({
      success: false,
      error: refusal.message,
      code: 403,
    });
  });

  it("refuses a principal without a kind, or of a kind the app does not admit, on every method", async () => {
    const app = await start();
    const { runner, kindless } = principals();
    for (const principal of [runner, kindless]) {
      await expect(app.as(principal).tokenService.heartbeat()).rejects.toMatchObject(
        refused("tokenService.heartbeat", principal.kind),
      );
      await expect(app.as(principal).taskService.get({ id: board.t1 })).rejects.toMatchObject(
        refused("taskService.get", principal.kind),
      );
      const { socket } = await app.connect(principal);
      expect(await emitWithAck(socket, "qd:sub", { s: "taskService", ids: [board.t1] })).toEqual({
        ok: false,
        e: refused("taskService", principal.kind),
      });
    }
  });

  it("shows in the access matrix, with the kind of each cell", async () => {
    const app = await start();
    const { user, agent } = principals();
    const { cells } = await describeAccessMatrix(app, {
      service: tokenService,
      principals: { ada: user, token: agent },
      cases: [
        { method: "mint", input: { label: "x" }, allow: ["ada"] },
        { method: "heartbeat", input: undefined, allow: ["ada", "token"] },
      ],
    });
    expect(cells.map((cell) => [cell.case, cell.principal, cell.kind, cell.actual])).toEqual([
      ["mint", "ada", "user", "allow"],
      ["mint", "token", "agent", "FORBIDDEN"],
      ["mint", "anonymous", undefined, "UNAUTHENTICATED"],
      ["heartbeat", "ada", "user", "allow"],
      ["heartbeat", "token", "agent", "allow"],
      ["heartbeat", "anonymous", undefined, "UNAUTHENTICATED"],
    ]);
    await expect(
      describeAccessMatrix(app, {
        service: tokenService,
        principals: { token: agent },
        cases: [{ method: "mint", input: { label: "x" }, allow: ["token"] }],
      }),
    ).rejects.toThrow("  mint as token (kind agent): expected allow, got FORBIDDEN");
  });
});

describe("a service's kinds", () => {
  const subscriptions = (): [string, Readonly<Record<string, unknown>>][] => [
    ["qd:sub", { s: "taskService", ids: [board.t1] }],
    ["qd:col:sub", { s: "taskService", c: "byProject", scope: board.p1 }],
    ["qd:watch", { s: "taskService", topic: `byProject:${board.p1}` }],
    ["qd:watch", { s: "taskService", topic: "service" }],
    ["qd:stream:sub", { s: "taskService", stream: "logs", scope: board.t1 }],
    ["qd:stream:sub", { s: "taskService", stream: "ticks" }],
  ];

  it("refuses an agent's subscriptions of every kind and its calls, whatever its grants", async () => {
    const app = await start();
    const { user, agent, admin } = principals();
    const ada = await app.connect(user);
    const tokens = [await app.connect(agent), await app.connect(admin)];
    for (const [event, frame] of subscriptions()) {
      expect(await emitWithAck(ada.socket, event, frame), event).toMatchObject({ ok: true });
      for (const token of tokens) {
        expect(await emitWithAck(token.socket, event, frame), event).toEqual({
          ok: false,
          e: refused("taskService", "agent"),
        });
      }
    }
    expect(await ada.call.taskService.get({ id: board.t1 })).toMatchObject({ id: board.t1 });
    for (const token of tokens) {
      await expect(token.call.taskService.get({ id: board.t1 })).rejects.toMatchObject(
        refused("taskService.get", "agent"),
      );
    }
  });

  it("keeps a public method and a public stream open to anonymous callers, though not to other kinds", async () => {
    const app = await start();
    const anonymous = await app.connect(null);
    const token = await app.connect(principals().agent);
    expect(await anonymous.call.taskService.ping()).toBe("pong");
    await expect(token.call.taskService.ping()).rejects.toMatchObject(
      refused("taskService.ping", "agent"),
    );
    const ticks = { s: "taskService", stream: "ticks" };
    expect(await emitWithAck(anonymous.socket, "qd:stream:sub", ticks)).toMatchObject({ ok: true });
    expect(
      await emitWithAck(anonymous.socket, "qd:sub", { s: "taskService", ids: [board.t1] }),
    ).toMatchObject({ ok: false, e: { code: "UNAUTHENTICATED" } });
  });

  it("drops the channel messages of an agent, and delivers a user's", async () => {
    const app = await start();
    const { user, agent, admin } = principals();
    const connections = [
      await app.connect(agent),
      await app.connect(admin),
      await app.connect(user),
    ];
    connections.forEach((connection, n) => {
      connection.socket.emit("qd:ch", ["taskService", "wave", { n }]);
    });
    for (const connection of connections) {
      await settle(connection.socket);
    }
    expect(waves).toEqual([{ userId: board.ada, n: 2 }]);
  });
});
