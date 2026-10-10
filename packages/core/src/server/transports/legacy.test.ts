// The 4.x legacy shim over real connections (RFC 0003 section 8.5): a client
// without `auth.qd` calls `"{service}:{method}"` with an ack and gets the 4.x
// `ServiceResponse` shape back. Its calls run with the `ctx.socketId` and
// `ctx.rooms` of the socket they arrived on, and a renamed service answers
// to its old name through `legacyWire.aliases`.

import { describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { defineContract, mutation, query, type EventFrame } from "../../index";
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
  tick,
  type AppPrincipal,
} from "../__tests__/fixtures";
import {
  createServer,
  type CallRecord,
  type PipelineOptions,
  type RoomLeave,
  type ServerOnlyOptions,
} from "../index";
import {
  call,
  next,
  trustingAuth,
  transportHarness,
  v5Auth,
  type ClientSocket,
} from "./__tests__/harness";
import { createProbe } from "./__tests__/probe";

const harness = transportHarness();

/** 4.x's reply type, as 4.1 `src/shared/types.ts:88-90` declares it. */
type ServiceResponse<T = unknown> =
  | { success: true; data: T }
  | { success: false; error: string; code?: number };

/** The error 4.x's query hooks reject with (4.1 `src/client/serviceError.ts`). */
class ServiceCallError extends Error {
  constructor(
    message: string,
    readonly code?: number,
  ) {
    super(message);
  }
}

/**
 * A 4.x call exactly as 4.x's client hooks make one
 * (4.1 `src/client/useService.ts:60-75`): emit `"{service}:{method}"` with
 * the payload and an ack, resolve `data`, reject with the error and its code.
 */
function legacyCall(socket: ClientSocket, event: string, payload?: unknown): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error("Request timeout")), 1000);
    const ack = (response: ServiceResponse) => {
      clearTimeout(timeout);
      if (response.success) {
        resolve(response.data);
      } else {
        reject(new ServiceCallError(response.error, response.code));
      }
    };
    if (payload === undefined) {
      socket.emit(event, ack);
    } else {
      socket.emit(event, payload, ack);
    }
  });
}

/**
 * The raw acknowledgement of a 4.x call. Without a payload nothing is sent
 * for it: Socket.IO would send an explicit `undefined` as `null`.
 */
function rawLegacyCall(
  socket: ClientSocket,
  event: string,
  payload: unknown,
  timeoutMs = 1000,
): Promise<unknown> {
  const timed = socket.timeout(timeoutMs);
  return payload === undefined ? timed.emitWithAck(event) : timed.emitWithAck(event, payload);
}

async function serve(extra: ServerOnlyOptions<AppPrincipal> & PipelineOptions = {}) {
  const logger = captureLogger();
  const records: CallRecord[] = [];
  const probe = createProbe();
  const { server, url } = await harness.start({
    services: [qd.defineService(task, { methods: taskDefaults }), probe.service],
    db,
    logger,
    auth: trustingAuth,
    legacyWire: true,
    onCall: (record) => records.push(record),
    ...extra,
  });
  return { server, url, logger, records, probe };
}

/** A 4.x client: `auth` without `qd`, as 4.x's provider connects (`{ token }`). */
async function connectLegacy(url: string, principal: AppPrincipal | null = alice) {
  const opened = harness.open(url, principal === null ? {} : { principal });
  const authInfo = next(opened.socket, "auth:info");
  await opened.connected;
  return { socket: opened.socket, authInfo: await authInfo };
}

describe("the legacy shim", () => {
  it("serves a 4.x call with the 4.x reply shape, through the dispatcher", async () => {
    const { url, records } = await serve();
    const { socket, authInfo } = await connectLegacy(url, granted(alice, { taskService: "Read" }));
    expect(authInfo).toEqual({
      userId: "alice",
      serviceAccess: { taskService: "Read" },
      principalType: "user",
    });
    const raw = await rawLegacyCall(socket, "taskService:get", { id: "t1" });
    expect(raw).toEqual({ success: true, data: taskRow() } satisfies ServiceResponse);
    expect(await legacyCall(socket, "probeService:echo", { text: "hi" })).toEqual({
      text: "hi",
      userId: "alice",
      transport: "legacy",
      grants: { taskService: "Read" },
    });
    expect(records.map((record) => [record.method, record.transport, record.outcome])).toEqual([
      ["get", "legacy", "ok"],
      ["echo", "legacy", "ok"],
    ]);
  });

  it("answers failures as { success: false, error, code } with the HTTP status", async () => {
    const { url } = await serve();
    const { socket } = await connectLegacy(url);
    const anonymous = await connectLegacy(url, null);
    const failures: [ClientSocket, string, unknown, number, string][] = [
      [socket, "taskService:rename", { id: 1 }, 422, "Invalid input for taskService.rename"],
      [anonymous.socket, "probeService:wait", { key: "k" }, 401, "Authentication required"],
      [socket, "probeService:moderate", { value: 1 }, 403, "Insufficient permissions"],
      [socket, "probeService:fail", { code: "CONFLICT" }, 409, "Failed with CONFLICT"],
      [socket, "probeService:fail", { code: "INTERNAL" }, 500, "Internal error"],
      [socket, "probeService:unencodable", undefined, 500, "Internal error"],
    ];
    for (const [client, event, payload, code, error] of failures) {
      expect(await rawLegacyCall(client, event, payload)).toEqual({
        success: false,
        error,
        code,
      } satisfies ServiceResponse);
      await expect(legacyCall(client, event, payload)).rejects.toEqual(
        new ServiceCallError(error, code),
      );
    }
  });

  it("calls a method without a payload, the way 4.x emits one", async () => {
    const { url } = await serve();
    const { socket } = await connectLegacy(url);
    await expect(legacyCall(socket, "probeService:unencodable")).rejects.toMatchObject({
      code: 500,
    });
  });

  it("ignores events that are not methods: subscriptions, unknown names, calls without an ack", async () => {
    const { url, records } = await serve();
    const { socket } = await connectLegacy(url);
    for (const event of [
      "taskService:subscribe",
      "taskService:remove",
      "chatService:get",
      "ping",
    ]) {
      // A reply would take a few milliseconds; none comes.
      await expect(rawLegacyCall(socket, event, { entryId: "t1" }, 150)).rejects.toThrow(
        "operation has timed out",
      );
    }
    socket.emit("taskService:get", { id: "t1" });
    expect(await legacyCall(socket, "taskService:get", { id: "t1" })).toEqual(taskRow());
    expect(records.map((record) => record.method)).toEqual(["get"]);
  });

  it("gives a 4.x socket no v5 listeners, and a v5 frame from it no reply", async () => {
    const { server, url } = await serve();
    const { socket } = await connectLegacy(url);
    const serverSocket = server.io.sockets.sockets.get(socket.id ?? "");
    expect(serverSocket?.data.protocol).toBe("legacy");
    expect(serverSocket?.eventNames()).toEqual(["error", "disconnect"]);
    await expect(
      socket.timeout(150).emitWithAck("qd:call", { id: 1, s: "taskService", m: "get" }),
    ).rejects.toThrow("operation has timed out");
  });

  it("logs each 4.x caller once per service, method and principal kind", async () => {
    const { url, logger } = await serve();
    const user = await connectLegacy(url);
    const agent = await connectLegacy(url, { userId: "runner-1", kind: "agent" });
    const anonymous = await connectLegacy(url, null);
    for (const socket of [user.socket, user.socket, agent.socket, anonymous.socket]) {
      await legacyCall(socket, "taskService:get", { id: "t1" });
    }
    await legacyCall(user.socket, "probeService:echo", { text: "x" });
    expect(logger.at("warn").map((entry) => [entry.message, entry.meta?.principalKind])).toEqual([
      ["A 4.x client called taskService.get through the legacy shim", "user"],
      ["A 4.x client called taskService.get through the legacy shim", "agent"],
      ["A 4.x client called taskService.get through the legacy shim", "anonymous"],
      ["A 4.x client called probeService.echo through the legacy shim", "user"],
    ]);
  });

  it("drops a 4.x call over the rate limit before it runs, answering in the 4.x shape with 4.1's error event", async () => {
    let runs = 0;
    const counter = defineContract("counterService", {
      methods: { bump: mutation({ input: z.object({}), output: z.number() }) },
    });
    const counterService = qd.defineService(counter, {
      methods: {
        bump: {
          access: "authenticated",
          handler: () => {
            runs += 1;
            return runs;
          },
        },
      },
    });
    const { url } = await harness.start({
      services: [counterService],
      db,
      logger: captureLogger(),
      auth: trustingAuth,
      legacyWire: true,
      rateLimit: { maxRequests: 2, windowMs: 60_000 },
    });
    const { socket } = await connectLegacy(url);
    const notice = next(socket, "error");
    const replies: unknown[] = [];
    for (let index = 0; index < 5; index += 1) {
      replies.push(await rawLegacyCall(socket, "counterService:bump", {}));
    }
    const limited = { success: false, error: "Rate limit exceeded", code: 429 };
    expect(replies).toEqual([
      { success: true, data: 1 },
      { success: true, data: 2 },
      limited,
      limited,
      limited,
    ]);
    expect(await notice).toMatchObject({ code: "RATE_LIMITED", retryAfter: expect.any(Number) });
    // A mutation is never cancelled, so a dropped call that had started anyway
    // would have run by now.
    await tick(20);
    expect(runs).toBe(2);

    // The same limit on a v5 socket of the same server runs the same calls.
    const v5 = harness.open(url, v5Auth(alice));
    await v5.hello;
    const codes: unknown[] = [];
    for (let id = 0; id < 5; id += 1) {
      const reply = (await call(v5.socket, { id, s: "counterService", m: "bump", i: {} })) as {
        readonly ok: boolean;
        readonly e?: { readonly code: string };
      };
      codes.push(reply.ok ? "ok" : reply.e?.code);
    }
    expect(codes).toEqual(["ok", "ok", "RATE_LIMITED", "RATE_LIMITED", "RATE_LIMITED"]);
    await tick(20);
    expect(runs).toBe(4);
  });

  it("cancels a 4.x socket's queries when it disconnects", async () => {
    const { url, probe } = await serve();
    const { socket } = await connectLegacy(url);
    void legacyCall(socket, "probeService:wait", { key: "legacy" }).catch(() => null);
    await expect.poll(() => probe.signals.has("legacy")).toBe(true);
    socket.disconnect();
    await expect.poll(() => probe.signals.get("legacy")?.aborted).toBe(true);
  });
});

const roomInput = z.object({ room: z.string() });

/** A service whose handlers use the calling socket: its id, joining and leaving rooms, room events. */
const roomContract = defineContract("roomService", {
  methods: {
    whoAmI: query({ input: z.object({}), output: z.string().nullable() }),
    join: mutation({ input: roomInput, output: z.boolean() }),
    leave: mutation({ input: roomInput, output: z.boolean() }),
    celebrate: mutation({ input: roomInput, output: z.null() }),
  },
  events: { celebrated: { payload: z.object({ room: z.string() }) } },
});

const roomService = qd.defineService(roomContract, {
  methods: {
    whoAmI: { access: "public", handler: ({ ctx }) => ctx.socketId ?? null },
    join: { access: "public", handler: ({ input, ctx }) => ctx.rooms.join(input.room) },
    leave: { access: "public", handler: ({ input, ctx }) => ctx.rooms.leave(input.room) },
    celebrate: {
      access: "public",
      handler: ({ input, ctx }) => {
        ctx.rooms.emit(input.room, roomContract, "celebrated", { room: input.room });
        return null;
      },
    },
  },
});

describe("the legacy shim's calls and the socket they arrived on", () => {
  async function serveRooms() {
    const heard: RoomLeave[] = [];
    const { server, url } = await harness.start({
      services: [roomService],
      db,
      logger: captureLogger(),
      auth: trustingAuth,
      legacyWire: true,
      onRoomLeave: (leave) => {
        heard.push(leave);
      },
    });
    return { server, url, heard };
  }

  it("gives a 4.x call ctx.socketId, the id of the client's socket", async () => {
    const { url } = await serveRooms();
    const { socket } = await connectLegacy(url);
    expect(await legacyCall(socket, "roomService:whoAmI", {})).toBe(socket.id);
    const anonymous = await connectLegacy(url, null);
    expect(await legacyCall(anonymous.socket, "roomService:whoAmI", {})).toBe(anonymous.socket.id);
  });

  it("joins a 4.x socket to an app room, where the app's raw emits and room events reach it", async () => {
    const { server, url } = await serveRooms();
    const { socket } = await connectLegacy(url);
    expect(await legacyCall(socket, "roomService:join", { room: "session:s1" })).toBe(true);
    expect(server.rooms.size("session:s1")).toBe(1);
    expect(await server.presence.users("session:s1")).toEqual(["alice"]);

    // The app's own 4.x delivery: a raw emit to the room.
    const message = next(socket, "session:message");
    server.io.to("session:s1").emit("session:message" as never, { text: "hi" } as never);
    expect(await message).toEqual({ text: "hi" });

    // A v5 socket in the same room gets the contract's event as a typed frame.
    const v5 = harness.open(url, v5Auth(granted(alice, {})));
    await v5.hello;
    const joined = await call(v5.socket, {
      id: 1,
      s: "roomService",
      m: "join",
      i: { room: "session:s1" },
    });
    expect(joined).toEqual({ ok: true, d: true });
    const event = next<EventFrame>(v5.socket, "qd:event");
    await legacyCall(socket, "roomService:celebrate", { room: "session:s1" });
    expect(await event).toEqual(["roomService", "celebrated", { room: "session:s1" }]);

    expect(await legacyCall(socket, "roomService:leave", { room: "session:s1" })).toBe(true);
    expect(server.rooms.size("session:s1")).toBe(1);
  });

  it("keeps the room rules: reserved names are refused", async () => {
    const { url } = await serveRooms();
    const { socket } = await connectLegacy(url);
    for (const room of ["qd:x", "user:bob"]) {
      expect(await rawLegacyCall(socket, "roomService:join", { room })).toMatchObject({
        success: false,
        code: 422,
      });
    }
  });

  it("leaves a 4.x socket's app rooms when it disconnects: onRoomLeave hears it and presence forgets it", async () => {
    const { server, url, heard } = await serveRooms();
    const { socket } = await connectLegacy(url);
    const socketId = socket.id;
    await legacyCall(socket, "roomService:join", { room: "session:s1" });
    socket.disconnect();
    await vi.waitFor(() => {
      expect(heard).toHaveLength(1);
    });
    expect(heard).toEqual([
      {
        principal: expect.objectContaining({ userId: "alice" }),
        socketId,
        reason: "disconnect",
        rooms: [{ room: "session:s1", last: true }],
      },
    ]);
    expect(server.rooms.size("session:s1")).toBe(0);
    expect(await server.presence.users("session:s1")).toEqual([]);
  });

  it("still serves no 4.x subscriptions", async () => {
    const { url } = await serveRooms();
    const { socket } = await connectLegacy(url);
    await expect(
      rawLegacyCall(socket, "roomService:subscribe", { room: "r" }, 150),
    ).rejects.toThrow("operation has timed out");
  });
});

/** The fixture's `taskService` after a migration renamed it: Read grants on `cardService` only. */
const cardContract = defineContract("cardService", {
  methods: {
    get: query({
      input: z.object({ id: z.string() }),
      output: z.object({ id: z.string(), service: z.string() }),
    }),
  },
});

const cardService = qd.defineService(cardContract, {
  methods: {
    get: {
      access: { service: "Read" },
      handler: ({ input }) => ({ id: input.id, service: "cardService" }),
    },
  },
});

describe("the legacy shim's service-name aliases", () => {
  async function serveAliases() {
    const logger = captureLogger();
    const records: CallRecord[] = [];
    const { url } = await harness.start({
      services: [cardService],
      db,
      logger,
      auth: trustingAuth,
      legacyWire: { aliases: { taskService: "cardService" } },
      onCall: (record) => records.push(record),
    });
    return { url, logger, records };
  }

  const reader = granted(alice, { cardService: "Read" });

  it("runs a call to the old name as the service it now names, access-checked as that service", async () => {
    const { url, records } = await serveAliases();
    const { socket, authInfo } = await connectLegacy(url, reader);
    // Grants are listed by the services' own names, never copied under an alias.
    expect(authInfo).toMatchObject({ serviceAccess: { cardService: "Read" } });
    expect(await legacyCall(socket, "taskService:get", { id: "c1" })).toEqual({
      id: "c1",
      service: "cardService",
    });
    expect(await legacyCall(socket, "cardService:get", { id: "c2" })).toEqual({
      id: "c2",
      service: "cardService",
    });

    // A grant under the old name is not a grant on the service.
    const stranger = await connectLegacy(url, granted(bob, { taskService: "Admin" }));
    expect(await rawLegacyCall(stranger.socket, "taskService:get", { id: "c1" })).toEqual({
      success: false,
      error: "Insufficient permissions",
      code: 403,
    } satisfies ServiceResponse);
    // Validation is the service's too.
    expect(await rawLegacyCall(socket, "taskService:get", { id: 1 })).toMatchObject({
      success: false,
      code: 422,
    });
    expect(
      records.map((record) => [record.service, record.method, record.transport, record.outcome]),
    ).toEqual([
      ["cardService", "get", "legacy", "ok"],
      ["cardService", "get", "legacy", "ok"],
      ["cardService", "get", "legacy", "FORBIDDEN"],
      ["cardService", "get", "legacy", "VALIDATION"],
    ]);
  });

  it("logs each caller once per name called, method and principal kind, naming the alias", async () => {
    const { url, logger } = await serveAliases();
    const user = await connectLegacy(url, reader);
    const agent = await connectLegacy(url, { ...reader, kind: "agent" });
    for (const socket of [user.socket, user.socket, agent.socket]) {
      await legacyCall(socket, "taskService:get", { id: "c1" });
    }
    await legacyCall(user.socket, "cardService:get", { id: "c1" });
    await legacyCall(user.socket, "cardService:get", { id: "c1" });
    expect(logger.at("warn").map((entry) => [entry.message, entry.meta])).toEqual([
      [
        "A 4.x client called cardService.get as taskService.get through the legacy shim",
        {
          category: "quickdraw.legacy",
          service: "cardService",
          method: "get",
          alias: "taskService",
          principalKind: "user",
        },
      ],
      [
        "A 4.x client called cardService.get as taskService.get through the legacy shim",
        {
          category: "quickdraw.legacy",
          service: "cardService",
          method: "get",
          alias: "taskService",
          principalKind: "agent",
        },
      ],
      [
        "A 4.x client called cardService.get through the legacy shim",
        {
          category: "quickdraw.legacy",
          service: "cardService",
          method: "get",
          principalKind: "user",
        },
      ],
    ]);
  });

  it("aliases 4.x events only: a v5 call to the old name is NOT_FOUND", async () => {
    const { url } = await serveAliases();
    const v5 = harness.open(url, v5Auth(reader));
    await v5.hello;
    expect(await call(v5.socket, { id: 1, s: "taskService", m: "get", i: { id: "c1" } })).toEqual({
      ok: false,
      e: expect.objectContaining({ code: "NOT_FOUND" }),
    });
    expect(await call(v5.socket, { id: 2, s: "cardService", m: "get", i: { id: "c1" } })).toEqual({
      ok: true,
      d: { id: "c1", service: "cardService" },
    });
  });

  it("finds nothing under a name that is not an alias, such as __proto__", async () => {
    const { url, records } = await serveAliases();
    const { socket } = await connectLegacy(url, reader);
    for (const event of ["__proto__:get", "constructor:get", "taskService:remove"]) {
      await expect(rawLegacyCall(socket, event, { id: "c1" }, 150)).rejects.toThrow(
        "operation has timed out",
      );
    }
    expect(records).toEqual([]);
  });

  it("refuses aliases that name no service, shadow a service or cannot be an event prefix", () => {
    const refused: [unknown, string][] = [
      [{ aliases: { taskService: "missingService" } }, "is not a registered service"],
      [{ aliases: { cardService: "cardService" } }, "is a registered service's own name"],
      [{ aliases: { "task:Service": "cardService" } }, 'without ":"'],
      [{ aliases: { "": "cardService" } }, 'without ":"'],
      [{ aliases: { taskService: 1 } }, "is not a registered service"],
      [{ alias: { taskService: "cardService" } }, 'unknown option "alias"'],
      ["yes", "must be a boolean or { aliases }"],
    ];
    for (const [legacyWire, message] of refused) {
      expect(() =>
        createServer({
          services: [cardService],
          db,
          logger: captureLogger(),
          http: false,
          legacyWire: legacyWire as ServerOnlyOptions["legacyWire"],
        }),
      ).toThrow(message);
    }
  });
});
