// The 4.x legacy shim over real connections (RFC 0003 section 8.5): a client
// without `auth.qd` calls `"{service}:{method}"` with an ack and gets the 4.x
// `ServiceResponse` shape back.

import { describe, expect, it } from "vitest";
import {
  alice,
  captureLogger,
  db,
  granted,
  qd,
  task,
  taskDefaults,
  taskRow,
  type AppPrincipal,
} from "../__tests__/fixtures";
import type { CallRecord, PipelineOptions, ServerOnlyOptions } from "../index";
import { next, trustingAuth, transportHarness, type ClientSocket } from "./__tests__/harness";
import { createProbe } from "./__tests__/probe";

const harness = transportHarness();

/** 4.x's reply type, as `legacy-src/shared/types.ts:88-90` declares it. */
type ServiceResponse<T = unknown> =
  | { success: true; data: T }
  | { success: false; error: string; code?: number };

/** The error 4.x's query hooks reject with (`legacy-src/client/serviceError.ts`). */
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
 * (`legacy-src/client/useService.ts:60-75`): emit `"{service}:{method}"` with
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

  it("answers a 4.x call over the rate limit in the 4.x shape, with 4.1's error event", async () => {
    const { url } = await serve({ rateLimit: { maxRequests: 1 } });
    const { socket } = await connectLegacy(url);
    const notice = next(socket, "error");
    await legacyCall(socket, "taskService:get", { id: "t1" });
    expect(await rawLegacyCall(socket, "taskService:get", { id: "t1" })).toEqual({
      success: false,
      error: "Rate limit exceeded",
      code: 429,
    });
    expect(await notice).toMatchObject({ code: "RATE_LIMITED", retryAfter: expect.any(Number) });
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
