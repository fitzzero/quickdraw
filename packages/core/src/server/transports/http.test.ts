// The HTTP transport over real requests (RFC 0003 section 10): `POST
// /qd/{service}/{method}` on the app's Express 4 or Express 5 app, or on a bare
// Node server, authenticated by session cookie or bearer token.

import { createServer as createHttpServer } from "node:http";
import { createRequire } from "node:module";
import type { AddressInfo } from "node:net";
import express from "express";
import { describe, expect, it, vi } from "vitest";
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
import {
  createDispatcher,
  createHttpRouter,
  type CallRecord,
  type HttpApp,
  type PipelineOptions,
  type ServerAuth,
  type ServerOnlyOptions,
} from "../index";
import { transportHarness } from "./__tests__/harness";
import { createProbe } from "./__tests__/probe";

/** Express 5, installed as the `express5` alias; its API matches Express 4's types here. */
const express5 = createRequire(import.meta.url)("express5") as typeof express;

const harness = transportHarness();

const TOKENS: Readonly<Record<string, AppPrincipal>> = {
  "alice-token": alice,
  "moderator-token": granted(alice, { probeService: "Moderate" }),
};

const tokenAuth: ServerAuth<AppPrincipal> = {
  authenticate: ({ auth, transport }) => {
    if (auth.token === "broken") {
      throw new Error("the session store is down");
    }
    expect(transport).toBe("http");
    return typeof auth.token === "string" ? TOKENS[auth.token] : null;
  },
};

async function serve(extra: ServerOnlyOptions<AppPrincipal> & PipelineOptions = {}) {
  const probe = createProbe();
  const logger = captureLogger();
  const records: CallRecord[] = [];
  const { server, url } = await harness.start({
    services: [qd.defineService(task, { methods: taskDefaults }), probe.service],
    db,
    logger,
    auth: tokenAuth,
    onCall: (record) => records.push(record),
    ...extra,
  });
  return { server, url, probe, logger, records };
}

interface Posted {
  readonly status: number;
  readonly body: unknown;
  readonly headers: Headers;
}

async function post(
  url: string,
  path: string,
  options: { body?: string; headers?: Record<string, string>; signal?: AbortSignal } = {},
): Promise<Posted> {
  const response = await fetch(`${url}${path}`, {
    method: "POST",
    headers: { "content-type": "application/json", ...options.headers },
    body: options.body,
    signal: options.signal,
  });
  const text = await response.text();
  return {
    status: response.status,
    body: text === "" ? undefined : (JSON.parse(text) as unknown),
    headers: response.headers,
  };
}

const bearer = (token: string) => ({ authorization: `Bearer ${token}` });

/** The four outcomes the card names, on any app. */
async function expectStatuses(url: string): Promise<void> {
  expect(
    await post(url, "/qd/taskService/get", {
      body: JSON.stringify({ id: "t1" }),
      headers: bearer("alice-token"),
    }),
  ).toMatchObject({ status: 200, body: { ok: true, d: taskRow() } });
  expect(await post(url, "/qd/probeService/wait", { body: '{"key":"x"}' })).toMatchObject({
    status: 401,
    body: { ok: false, e: { code: "UNAUTHENTICATED", message: "Authentication required" } },
  });
  expect(
    await post(url, "/qd/probeService/moderate", {
      body: '{"value":1}',
      headers: bearer("alice-token"),
    }),
  ).toMatchObject({ status: 403, body: { ok: false, e: { code: "FORBIDDEN" } } });
  expect(
    await post(url, "/qd/taskService/rename", {
      body: JSON.stringify({ id: 7 }),
      headers: bearer("alice-token"),
    }),
  ).toMatchObject({
    status: 422,
    body: {
      ok: false,
      e: { code: "VALIDATION", data: { issues: [{ path: ["id"] }, { path: ["title"] }] } },
    },
  });
}

describe("on an Express 4 app with its own JSON parser", () => {
  it("answers 200, 401, 403 and 422, and leaves the app's routes alone", async () => {
    const app = express();
    app.use(express.json());
    app.get("/health", (_req, res) => {
      res.json({ status: "ok" });
    });
    const { url, records } = await serve({ app });
    await expectStatuses(url);
    expect(
      await post(url, "/qd/probeService/moderate", {
        body: '{"value":21}',
        headers: bearer("moderator-token"),
      }),
    ).toMatchObject({ status: 200, body: { ok: true, d: 42 } });
    expect(await (await fetch(`${url}/health`)).json()).toEqual({ status: "ok" });
    expect((await fetch(`${url}/qd/taskService/get`)).status).toBe(404);
    expect(records.map((record) => [record.method, record.transport, record.outcome])).toEqual([
      ["get", "http", "ok"],
      ["wait", "http", "UNAUTHENTICATED"],
      ["moderate", "http", "FORBIDDEN"],
      ["rename", "http", "VALIDATION"],
      ["moderate", "http", "ok"],
    ]);
    expect(records[0]?.bytes).toBe(Buffer.byteLength(JSON.stringify({ ok: true, d: taskRow() })));
  });
});

describe("on an Express 5 app without a JSON parser", () => {
  it("reads the body itself and answers the same", async () => {
    const { version } = createRequire(import.meta.url)("express5/package.json") as {
      version: string;
    };
    expect(version).toMatch(/^5\./);
    const app = express5();
    const { url } = await serve({ app: app as unknown as HttpApp });
    await expectStatuses(url);
  });
});

describe("on a bare Node server", () => {
  it("serves calls without any app, and answers anything else with 404", async () => {
    const { url } = await serve();
    await expectStatuses(url);
    expect((await fetch(`${url}/elsewhere`, { method: "POST" })).status).toBe(404);
  });
});

describe("credentials", () => {
  it("reads the session cookie, before a bearer token, with or without cookie-parser", async () => {
    const { url } = await serve();
    const echo = (headers: Record<string, string>) =>
      post(url, "/qd/probeService/echo", { body: '{"text":"hi"}', headers });
    expect(await echo({ cookie: "theme=dark; session=alice-token" })).toMatchObject({
      status: 200,
      body: { ok: true, d: { userId: "alice", transport: "http" } },
    });
    expect(
      await echo({ cookie: "session=moderator-token", ...bearer("alice-token") }),
    ).toMatchObject({ body: { d: { grants: { probeService: "Moderate" } } } });
    expect(await echo({})).toMatchObject({ status: 200, body: { d: { userId: null } } });
  });

  it("answers 401 when authenticate throws", async () => {
    const { url, logger } = await serve();
    expect(
      await post(url, "/qd/probeService/echo", { body: '{"text":"x"}', headers: bearer("broken") }),
    ).toMatchObject({
      status: 401,
      body: { ok: false, e: { code: "UNAUTHENTICATED", message: "Authentication failed" } },
    });
    expect(logger.at("error").map((entry) => entry.message)).toEqual([
      "HTTP authentication failed",
    ]);
  });
});

describe("requests the transport refuses", () => {
  it("needs a JSON content type, even without a body, and valid JSON within the size limit", async () => {
    const { url } = await serve({ http: { maxBodyBytes: 64 } });
    const refused = { status: 422, body: { ok: false, e: { code: "VALIDATION" } } };
    const notJson = await post(url, "/qd/probeService/echo", {
      body: '{"text":"x"}',
      headers: { "content-type": "text/plain" },
    });
    expect(notJson).toMatchObject(refused);
    expect(notJson.body).toMatchObject({
      e: { message: "Send the input as a JSON body with Content-Type: application/json" },
    });
    expect(
      await post(url, "/qd/probeService/echo", { headers: { "content-type": "text/plain" } }),
    ).toMatchObject(refused);
    expect(await post(url, "/qd/probeService/echo", { body: '{"text":' })).toMatchObject({
      ...refused,
      body: { e: { message: "The request body is not valid JSON" } },
    });
    expect(
      await post(url, "/qd/probeService/echo", { body: JSON.stringify({ text: "x".repeat(100) }) }),
    ).toMatchObject({
      ...refused,
      body: { e: { message: "The request body is larger than 64 bytes" } },
    });
    expect(await post(url, "/qd/probeService/echo", { body: '{"text":"fits"}' })).toMatchObject({
      status: 200,
    });
  });

  it("maps every code to its status, with Retry-After on RATE_LIMITED", async () => {
    const { url } = await serve();
    const fail = (code: string) =>
      post(url, "/qd/probeService/fail", { body: JSON.stringify({ code }) });
    const limited = await fail("RATE_LIMITED");
    expect(limited).toMatchObject({ status: 429, body: { e: { data: { retryAfterMs: 1500 } } } });
    expect(limited.headers.get("retry-after")).toBe("2");
    expect((await fail("CONFLICT")).status).toBe(409);
    expect((await fail("CANCELLED")).status).toBe(499);
    expect((await fail("TIMEOUT")).status).toBe(504);
    expect(await fail("INTERNAL")).toMatchObject({
      status: 500,
      body: { ok: false, e: { code: "INTERNAL", message: "Internal error" } },
    });
    expect(await post(url, "/qd/probeService/unencodable")).toMatchObject({
      status: 500,
      body: { ok: false, e: { code: "INTERNAL", message: "Internal error" } },
    });
    expect(await post(url, "/qd/chatService/get")).toMatchObject({ status: 404 });
  });
});

describe("a request that goes away", () => {
  it("cancels its call", async () => {
    const { url, probe, records } = await serve();
    const controller = new AbortController();
    const pending = post(url, "/qd/probeService/wait", {
      body: '{"key":"http"}',
      headers: bearer("alice-token"),
      signal: controller.signal,
    }).catch((error: unknown) => error);
    await vi.waitFor(() => expect(probe.signals.has("http")).toBe(true));
    controller.abort();
    await vi.waitFor(() => expect(probe.signals.get("http")?.aborted).toBe(true));
    expect(await pending).toBeInstanceOf(Error);
    await vi.waitFor(() => expect(records.map((record) => record.outcome)).toEqual(["CANCELLED"]));
    expect(records[0]?.bytes).toBe(0);
  });
});

describe("the http option", () => {
  it("moves the transport to another path, or turns it off", async () => {
    const moved = await serve({ http: { path: "/rpc/" } });
    expect((await post(moved.url, "/rpc/taskService/get", { body: '{"id":"t1"}' })).status).toBe(
      200,
    );
    expect((await post(moved.url, "/qd/taskService/get", { body: '{"id":"t1"}' })).status).toBe(
      404,
    );
    const off = await serve({ http: false });
    expect((await post(off.url, "/qd/taskService/get", { body: '{"id":"t1"}' })).status).toBe(404);
    expect(() =>
      createHttpRouter({ dispatcher: moved.server.dispatcher, maxBodyBytes: 0 }),
    ).toThrow("http.maxBodyBytes must be a whole number of bytes, 1 or more");
  });
});

describe("createHttpRouter", () => {
  it("serves a dispatcher on its own, without sockets", async () => {
    const dispatcher = createDispatcher({
      services: [qd.defineService(task, { methods: taskDefaults })],
      db,
      logger: captureLogger(),
    });
    const httpServer = createHttpServer(
      createHttpRouter({ dispatcher, auth: tokenAuth, logger: captureLogger() }),
    );
    await new Promise<void>((resolve) => {
      httpServer.listen(0, "127.0.0.1", resolve);
    });
    try {
      const { port } = httpServer.address() as AddressInfo;
      const url = `http://127.0.0.1:${port}`;
      expect(await post(url, "/qd/taskService/get", { body: '{"id":"t1"}' })).toMatchObject({
        status: 200,
        body: { ok: true, d: taskRow() },
      });
      expect(
        await post(url, "/qd/taskService/rename", { body: '{"id":"t1","title":"x"}' }),
      ).toMatchObject({ status: 401 });
    } finally {
      await new Promise((resolve) => {
        httpServer.close(resolve);
      });
    }
  });
});
