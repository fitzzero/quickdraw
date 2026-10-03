// What a socket passes before it is served (RFC 0003 section 8.1): the
// protocol check, authentication with `loadServiceAccess`, and the socket
// rate limiter answering in each protocol's reply shape.

import { describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { defineContract, isProtocolMismatch, PROTOCOL_VERSION, query } from "../../index";
import {
  alice,
  captureLogger,
  db,
  granted,
  qd,
  task,
  taskDefaults,
  type AppPrincipal,
} from "../__tests__/fixtures";
import { initQuickdraw, type PipelineOptions, type ServerOnlyOptions } from "../index";
import { call, trustingAuth, transportHarness, v5Auth } from "./__tests__/harness";
import { createProbe } from "./__tests__/probe";

const harness = transportHarness();

async function serve(extra: ServerOnlyOptions<AppPrincipal> & PipelineOptions = {}) {
  const logger = captureLogger();
  const { server, url } = await harness.start({
    services: [qd.defineService(task, { methods: taskDefaults }), createProbe().service],
    db,
    logger,
    auth: trustingAuth,
    ...extra,
  });
  return { server, url, logger };
}

async function refusal(url: string, auth: Record<string, unknown> | undefined) {
  const opened = harness.open(url, auth);
  const error: unknown = await opened.connected.then(
    () => {
      throw new Error("the connection was accepted");
    },
    (reason: unknown) => reason,
  );
  return error as Error & { readonly data?: unknown };
}

describe("the protocol check", () => {
  it.each([
    ["no auth.qd (a 4.x client)", { token: "t" }],
    ["no auth at all", undefined],
    ["another protocol", { qd: { protocol: 4, client: "4.1.0" } }],
    ["a malformed qd", { qd: { protocol: "5" } }],
  ])("refuses %s with PROTOCOL_MISMATCH when legacyWire is off", async (_label, auth) => {
    const { url } = await serve();
    const error = await refusal(url, auth);
    expect(error.message).toBe("This server speaks quickdraw protocol 5");
    expect(error.data).toEqual({ code: "PROTOCOL_MISMATCH", expected: PROTOCOL_VERSION });
    expect(isProtocolMismatch(error.data)).toBe(true);
  });

  it("still refuses another protocol when legacyWire is on", async () => {
    const { url } = await serve({ legacyWire: true });
    const error = await refusal(url, { qd: { protocol: 6, client: "6.0.0" } });
    expect(isProtocolMismatch(error.data)).toBe(true);
  });
});

describe("authentication", () => {
  const who = defineContract("whoService", {
    methods: { whoami: query({ input: z.undefined(), output: z.unknown() }) },
  });

  it("accepts a bare user id, and loads the grants a principal does not carry", async () => {
    const loadServiceAccess = vi.fn((userId: string) =>
      Promise.resolve(userId === "carol" ? { whoService: "Moderate" as const } : null),
    );
    const app = initQuickdraw();
    const whoService = app.defineService(who, {
      methods: { whoami: { access: "authenticated", handler: ({ ctx }) => ctx.principal } },
    });
    const { url } = await harness.start({
      services: [whoService],
      logger: captureLogger(),
      auth: {
        authenticate: ({ auth, transport, headers }) => {
          expect(transport).toBe("socket");
          expect(headers.host).toMatch(/^127\.0\.0\.1:/);
          if (typeof auth.token === "string") {
            return auth.token;
          }
          return (auth.principal as AppPrincipal | undefined) ?? null;
        },
        loadServiceAccess,
      },
    });
    const whoami = async (auth: Record<string, unknown>) => {
      const opened = harness.open(url, auth);
      await opened.hello;
      return call(opened.socket, { id: 1, s: "whoService", m: "whoami" });
    };
    const qdAuth = v5Auth(null);
    expect(await whoami({ ...qdAuth, token: "carol" })).toEqual({
      ok: true,
      d: { userId: "carol", serviceAccess: { whoService: "Moderate" } },
    });
    expect(await whoami({ ...qdAuth, token: "dave" })).toEqual({
      ok: true,
      d: { userId: "dave", serviceAccess: {} },
    });
    const carrying = granted(alice, { whoService: "Read" });
    expect(await whoami(v5Auth(carrying))).toEqual({ ok: true, d: carrying });
    expect(loadServiceAccess.mock.calls).toEqual([["carol"], ["dave"]]);
  });

  it("refuses the connection when authenticate throws or returns no principal", async () => {
    const { url, logger } = await serve({
      auth: {
        authenticate: ({ auth }) => {
          if (auth.token === "throw") {
            throw new Error("the session store is down");
          }
          return { kind: "user" } as unknown as AppPrincipal;
        },
      },
    });
    expect((await refusal(url, { ...v5Auth(null), token: "throw" })).message).toBe(
      "Authentication failed",
    );
    expect((await refusal(url, v5Auth(null))).message).toBe("Authentication failed");
    expect(logger.at("error").map((entry) => entry.message)).toEqual([
      "Socket authentication failed",
      "Socket authentication failed",
    ]);
  });

  it("serves a socket anonymously when authenticate returns nothing, or there is none", async () => {
    for (const auth of [trustingAuth, undefined]) {
      const { url } = await serve({ auth });
      const opened = harness.open(url, v5Auth(null));
      await opened.hello;
      expect(
        await call(opened.socket, { id: 1, s: "probeService", m: "echo", i: { text: "x" } }),
      ).toMatchObject({ ok: true, d: { userId: null } });
    }
  });
});

describe("the socket rate limiter", () => {
  it("answers a v5 call over the limit with RATE_LIMITED, and never counts qd:cancel", async () => {
    const { url } = await serve({ rateLimit: { maxRequests: 2, windowMs: 60_000 } });
    const opened = harness.open(url, v5Auth(alice));
    await opened.hello;
    const { socket } = opened;
    for (let index = 0; index < 5; index += 1) {
      socket.emit("qd:cancel", { id: index });
    }
    const get = (id: number) => call(socket, { id, s: "taskService", m: "get", i: { id: "t1" } });
    expect(await get(1)).toMatchObject({ ok: true });
    expect(await get(2)).toMatchObject({ ok: true });
    expect(await get(3)).toEqual({
      ok: false,
      e: {
        code: "RATE_LIMITED",
        message: "Rate limit exceeded",
        data: { retryAfterMs: expect.any(Number) },
      },
    });
  });

  it("can be turned off", async () => {
    const { url } = await serve({ rateLimit: false });
    const opened = harness.open(url, v5Auth(alice));
    await opened.hello;
    for (let id = 0; id < 120; id += 1) {
      opened.socket.emit("qd:call", { id, s: "taskService", m: "get", i: { id: "t1" } });
    }
    expect(
      await call(opened.socket, { id: 500, s: "taskService", m: "get", i: { id: "t1" } }),
    ).toMatchObject({ ok: true });
  });
});
