// The MCP HTTP routes (RFC 0003 section 10): 4.1's `GET /mcp/tools` and
// `POST /mcp/invoke` over the registry, on Express 4, Express 5 and a bare
// Node server, authenticated by bearer token through the registry's
// `principal` hook.

import {
  createServer as createHttpServer,
  request as httpRequest,
  type RequestListener,
  type Server,
} from "node:http";
import { createRequire } from "node:module";
import type { AddressInfo } from "node:net";
import express from "express";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createJWT } from "../auth/jwt";
import { bearerAuth } from "../auth/routes/bearerAuth";
import { createMemorySessionStore } from "../auth/routes/sessions";
import { issueSession } from "../auth/routes/tokens";
import type { PipelineOptions } from "../index";
import { agentAuth, bindSetup, setup } from "./__tests__/fixtures";
import { createMcpHttpRouter, type McpHttpRouterOptions } from "./index";

/** Express 5, installed as the `express5` alias; its API matches Express 4's types here. */
const express5 = createRequire(import.meta.url)("express5") as typeof express;

const servers: Server[] = [];

afterEach(async () => {
  await Promise.all(
    servers.splice(0).map(
      (server) =>
        new Promise((resolveClose) => {
          server.closeAllConnections();
          server.close(resolveClose);
        }),
    ),
  );
});

async function listen(listener: RequestListener): Promise<string> {
  const server = createHttpServer(listener);
  servers.push(server);
  await new Promise<void>((resolveListen) => {
    server.listen(0, "127.0.0.1", resolveListen);
  });
  return `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
}

/** The registry's tools over HTTP, with bearer tokens mapped by the fixtures' `agentAuth`. */
function routes(
  options: Omit<McpHttpRouterOptions, "registry"> = {},
  pipeline: PipelineOptions = {},
) {
  const fixture = setup(
    agentAuth((request) => (request.transport === "http" ? request.token : null)),
    pipeline,
  );
  const router = createMcpHttpRouter({
    registry: fixture.registry,
    logger: fixture.logger,
    ...options,
  });
  return { ...fixture, router };
}

interface Answer {
  readonly status: number;
  readonly body: unknown;
}

async function invoke(
  url: string,
  body: unknown,
  options: { token?: string; contentType?: string; path?: string; signal?: AbortSignal } = {},
): Promise<Answer> {
  const response = await fetch(`${url}${options.path ?? "/mcp/invoke"}`, {
    method: "POST",
    headers: {
      "content-type": options.contentType ?? "application/json",
      ...(options.token === undefined ? {} : { authorization: `Bearer ${options.token}` }),
    },
    body: typeof body === "string" ? body : JSON.stringify(body),
    signal: options.signal,
  });
  const text = await response.text();
  return { status: response.status, body: text === "" ? undefined : (JSON.parse(text) as unknown) };
}

/** What every app answers, whatever serves the routes. */
async function expectRoutes(url: string): Promise<void> {
  const listed = await fetch(`${url}/mcp/tools`);
  expect(listed.status).toBe(200);
  const { tools } = (await listed.json()) as { tools: { name: string }[] };
  expect(tools.map((tool) => tool.name)).toContain("taskService_rename");
  expect(
    await invoke(
      url,
      { name: "taskService_get", arguments: { id: "t1" } },
      { token: "reader-token" },
    ),
  ).toEqual({
    status: 200,
    body: { success: true, data: { id: "t1", title: "Write the RFC", done: false } },
  });
  expect(
    await invoke(
      url,
      { service: "noteService", method: "search", payload: "rfc" },
      { token: "reader-token" },
    ),
  ).toEqual({ status: 200, body: { success: true, data: ["a note about rfc"] } });
  expect(
    await invoke(
      url,
      { name: "taskService_rename", arguments: { id: "t1", title: "Ship it" } },
      { token: "reader-token" },
    ),
  ).toEqual({
    status: 403,
    body: { success: false, error: "Insufficient permissions", code: "FORBIDDEN" },
  });
  expect(
    await invoke(url, { name: "taskService_get", arguments: {} }, { token: "writer-token" }),
  ).toMatchObject({
    status: 422,
    body: { success: false, code: "VALIDATION", data: { issues: [{ path: ["id"] }] } },
  });
  expect(await invoke(url, { name: "taskService_get", arguments: { id: "t1" } })).toEqual({
    status: 401,
    body: { success: false, error: "Authentication required", code: "UNAUTHENTICATED" },
  });
  expect(await invoke(url, { name: "nope", arguments: {} })).toEqual({
    status: 404,
    body: { success: false, error: 'Unknown tool "nope"', code: "NOT_FOUND" },
  });
}

describe("on an Express 4 app with its own JSON parser", () => {
  it("lists and calls tools, and leaves the app's routes alone", async () => {
    const { router, records } = routes();
    const app = express();
    app.use(express.json());
    app.get("/health", (_req, res) => {
      res.json({ status: "ok" });
    });
    app.use(router);
    const url = await listen(app);
    await expectRoutes(url);
    expect(await (await fetch(`${url}/health`)).json()).toEqual({ status: "ok" });
    expect((await fetch(`${url}/mcp/invoke`)).status).toBe(404);
    expect(records.map((record) => [record.method, record.transport, record.outcome])).toEqual([
      ["get", "mcp", "ok"],
      ["search", "mcp", "ok"],
      ["rename", "mcp", "FORBIDDEN"],
      ["get", "mcp", "VALIDATION"],
      ["get", "mcp", "UNAUTHENTICATED"],
    ]);
    expect(records[0]?.bytes).toBeGreaterThan(0);
  });
});

describe("on an Express 5 app without a JSON parser", () => {
  it("reads the body itself and answers the same", async () => {
    const { version } = createRequire(import.meta.url)("express5/package.json") as {
      version: string;
    };
    expect(version).toMatch(/^5\./);
    const { router } = routes();
    const app = express5();
    app.use(router);
    await expectRoutes(await listen(app));
  });
});

describe("on a bare Node server", () => {
  it("serves the routes without any app, and answers anything else with 404", async () => {
    const { router } = routes();
    const url = await listen(router);
    await expectRoutes(url);
    expect(await invoke(url, {}, { path: "/elsewhere" })).toEqual({
      status: 404,
      body: { success: false, error: "Not found", code: "NOT_FOUND" },
    });
  });

  it("says no-store and nosniff on the tool list, a call, a refusal and a 404 alike", async () => {
    const { router } = routes();
    const url = await listen(router);
    const post = (body: unknown, token?: string) =>
      fetch(`${url}/mcp/invoke`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          ...(token === undefined ? {} : { authorization: `Bearer ${token}` }),
        },
        body: JSON.stringify(body),
      });
    const call = { name: "taskService_get", arguments: { id: "t1" } };
    const responses = await Promise.all([
      fetch(`${url}/mcp/tools`),
      post(call, "reader-token"),
      post(call),
      fetch(`${url}/elsewhere`),
    ]);
    expect(responses.map((response) => response.status)).toEqual([200, 200, 401, 404]);
    for (const { headers } of responses) {
      expect(headers.get("cache-control")).toBe("no-store");
      expect(headers.get("x-content-type-options")).toBe("nosniff");
    }
  });
});

describe("requests the routes refuse", () => {
  it("needs a JSON body naming a tool or a method, within the size limit, and a known token", async () => {
    const { router, logger } = routes({ maxBodyBytes: 64 });
    const url = await listen(router);
    expect(
      await invoke(
        url,
        { name: "noteService_search", arguments: { input: "x" } },
        { contentType: "text/plain" },
      ),
    ).toMatchObject({
      status: 422,
      body: {
        code: "VALIDATION",
        error: "Send the call as a JSON body with Content-Type: application/json",
      },
    });
    expect(await invoke(url, { tool: "noteService_search" })).toMatchObject({
      status: 422,
      body: {
        error:
          "Send { name, arguments } to call a tool, or { service, method, payload } to call a method's tool",
      },
    });
    expect(await invoke(url, '{"name":')).toMatchObject({
      status: 422,
      body: { error: "The request body is not valid JSON" },
    });
    expect(
      await invoke(url, { name: "noteService_search", arguments: { input: "x".repeat(80) } }),
    ).toMatchObject({
      status: 422,
      body: { error: "The request body is larger than 64 bytes" },
    });
    expect(await invoke(url, { name: "taskService_whoami" }, { token: "stolen-token" })).toEqual({
      status: 401,
      body: { success: false, error: "Authentication failed", code: "UNAUTHENTICATED" },
    });
    // The hook refused the token: logged at debug, and the token is never logged (MCP-7).
    expect(logger.at("error")).toEqual([]);
    expect(logger.at("debug").map((entry) => entry.message)).toContain("MCP authentication failed");
    expect(JSON.stringify(logger.entries)).not.toContain("stolen-token");
    expect(() => createMcpHttpRouter({ registry: setup().registry, maxBodyBytes: 0 })).toThrow(
      "createMcpHttpRouter: maxBodyBytes must be a whole number of bytes, 1 or more",
    );
  });
});

/** A raw request, whose Host and Origin headers are sent as given (fetch may drop or rewrite them). */
function raw(
  url: string,
  options: {
    readonly method: "GET" | "POST";
    readonly path: string;
    readonly headers?: Readonly<Record<string, string>>;
    readonly body?: unknown;
  },
): Promise<Answer> {
  const target = new URL(url);
  const body = options.body === undefined ? undefined : JSON.stringify(options.body);
  return new Promise((resolveAnswer, rejectAnswer) => {
    const sent = httpRequest(
      {
        host: target.hostname,
        port: target.port,
        method: options.method,
        path: options.path,
        headers: {
          ...(body === undefined ? {} : { "content-type": "application/json" }),
          ...options.headers,
        },
      },
      (response) => {
        let text = "";
        response.setEncoding("utf8");
        response.on("data", (chunk: string) => {
          text += chunk;
        });
        response.on("end", () => {
          resolveAnswer({
            status: response.statusCode ?? 0,
            body: text === "" ? undefined : (JSON.parse(text) as unknown),
          });
        });
      },
    );
    sent.on("error", rejectAnswer);
    sent.end(body);
  });
}

describe("a request from a web page (MCP-3)", () => {
  const search = { name: "noteService_search", arguments: { input: "x" } };
  const refused = { status: 403, body: { success: false, code: "FORBIDDEN" } };

  it("is refused unless allowedOrigins lists its Origin; a request without one is no page's", async () => {
    const url = await listen(routes().router);
    const attacker = { origin: "http://attacker.example" };
    expect(await raw(url, { method: "GET", path: "/mcp/tools", headers: attacker })).toMatchObject(
      refused,
    );
    expect(
      await raw(url, { method: "POST", path: "/mcp/invoke", headers: attacker, body: search }),
    ).toMatchObject(refused);
    expect(await raw(url, { method: "POST", path: "/mcp/invoke", body: search })).toMatchObject({
      status: 200,
    });
    const listed = await listen(routes({ allowedOrigins: ["http://app.example"] }).router);
    const call = (origin: string) =>
      raw(listed, { method: "POST", path: "/mcp/invoke", headers: { origin }, body: search });
    expect(await call("http://app.example")).toMatchObject({ status: 200 });
    expect(await call("http://other.example")).toMatchObject(refused);
  });

  it("is refused for a Host that allowedHosts does not list", async () => {
    const url = await listen(routes({ allowedHosts: ["127.0.0.1"] }).router);
    expect(await raw(url, { method: "POST", path: "/mcp/invoke", body: search })).toMatchObject({
      status: 200,
    });
    expect(
      await raw(url, {
        method: "POST",
        path: "/mcp/invoke",
        headers: { host: "attacker.example:4000" },
        body: search,
      }),
    ).toMatchObject(refused);
  });

  it("checks the options when the router is made", () => {
    const { registry } = setup();
    expect(() => createMcpHttpRouter({ registry, allowedOrigins: ["not an origin"] })).toThrow(
      TypeError,
    );
    expect(() => createMcpHttpRouter({ registry, allowedHosts: [""] })).toThrow(TypeError);
  });
});

describe("one caller's lane over HTTP (MCP-4)", () => {
  it("holds the queries of every anonymous request from one address", async () => {
    const { router, services } = routes(
      {},
      { limits: { maxInFlightQueries: 1, maxQueuedQueries: 0 } },
    );
    const url = await listen(router);
    const first = invoke(url, { name: "noteService_wait", arguments: { key: "a" } });
    await vi.waitFor(() => expect(services.gates.has("a")).toBe(true));
    expect(await invoke(url, { name: "noteService_wait", arguments: { key: "b" } })).toMatchObject({
      status: 429,
      body: { code: "RATE_LIMITED" },
    });
    services.gates.get("a")?.resolve("A");
    expect(await first).toMatchObject({ status: 200, body: { success: true, data: "A" } });
  });
});

describe("custom tools over HTTP", () => {
  it("answer an anonymous request with 401 unless their access is public", async () => {
    const handler = vi.fn(({ principal }: { readonly principal: unknown }) => ({
      ranAs: principal,
    }));
    const fixture = setup({
      ...agentAuth((request) => (request.transport === "http" ? request.token : null)),
      customTools: [
        {
          name: "export_all_users",
          description: "Dumps every user, for the ops agent.",
          inputSchema: { type: "object" },
          handler,
        },
        {
          name: "status",
          description: "Says whether the service is up.",
          inputSchema: { type: "object" },
          access: "public",
          handler,
        },
      ],
    });
    const url = await listen(
      createMcpHttpRouter({ registry: fixture.registry, logger: fixture.logger }),
    );
    expect(await invoke(url, { name: "export_all_users", arguments: {} })).toEqual({
      status: 401,
      body: { success: false, error: "Authentication required", code: "UNAUTHENTICATED" },
    });
    expect(handler).not.toHaveBeenCalled();
    expect(
      await invoke(url, { name: "export_all_users", arguments: {} }, { token: "reader-token" }),
    ).toEqual({
      status: 200,
      body: { success: true, data: { ranAs: { userId: "alice", kind: "agent" } } },
    });
    expect(await invoke(url, { name: "status", arguments: {} })).toEqual({
      status: 200,
      body: { success: true, data: { ranAs: null } },
    });
  });
});

describe("bound arguments over HTTP", () => {
  it("are left out of GET /mcp/tools, and a refused call answers 403 at once", async () => {
    const fixture = bindSetup(
      agentAuth((request) => (request.transport === "http" ? request.token : null)),
    );
    const url = await listen(
      createMcpHttpRouter({ registry: fixture.registry, logger: fixture.logger }),
    );
    const { tools } = (await (await fetch(`${url}/mcp/tools`)).json()) as {
      tools: { name: string; inputSchema: { properties: object } }[];
    };
    expect(
      tools.find((tool) => tool.name === "messageService_post")?.inputSchema.properties,
    ).toEqual({ message: { type: "string", minLength: 1 } });
    // a refusal that never reached respond would leave the request open until this aborts it
    const signal = AbortSignal.timeout(5_000);
    expect(
      await invoke(
        url,
        { name: "messageService_post", arguments: { message: "hi" } },
        { token: "task-token", signal },
      ),
    ).toEqual({
      status: 200,
      body: { success: true, data: { taskId: "t1", message: "hi", by: "bob" } },
    });
    expect(
      await invoke(
        url,
        { name: "messageService_post", arguments: { taskId: "t2", message: "hi" } },
        { token: "task-token", signal },
      ),
    ).toEqual({
      status: 403,
      body: {
        success: false,
        error: '"taskId" is bound to the caller and cannot be set to another value',
        code: "FORBIDDEN",
      },
    });
    expect(
      await invoke(
        url,
        { service: "messageService", method: "post", payload: { taskId: "t2", message: "hi" } },
        { token: "task-token", signal },
      ),
    ).toMatchObject({ status: 403, body: { code: "FORBIDDEN" } });
    expect(
      await invoke(
        url,
        { name: "messageService_post", arguments: { message: "hi" } },
        { token: "writer-token", signal },
      ),
    ).toEqual({
      status: 403,
      body: {
        success: false,
        error: '"taskId" is bound to the caller, who has none',
        code: "FORBIDDEN",
      },
    });
    expect(
      await invoke(url, { name: "messageService_post", arguments: { message: "hi" } }, { signal }),
    ).toEqual({
      status: 401,
      body: { success: false, error: "Authentication required", code: "UNAUTHENTICATED" },
    });
    expect(fixture.records.map((record) => [record.method, record.outcome])).toEqual([
      ["post", "ok"],
    ]);
  });
});

describe("a session token through bearerAuth", () => {
  it("stops working as soon as its session is revoked, and a JWT without a session never works (MCP-2)", async () => {
    const sessions = createMemorySessionStore();
    const jwtSecret = "a-test-secret-of-at-least-thirty-two-characters";
    const verify = bearerAuth({
      sessions,
      jwtSecret,
      loadPrincipal: (userId) => ({ userId, kind: "agent" as const }),
    });
    const fixture = setup({
      principal: (request) => verify(request.transport === "http" ? request.token : null),
      context: () => ({ scopes: [] }),
    });
    const url = await listen(
      createMcpHttpRouter({ registry: fixture.registry, logger: fixture.logger }),
    );
    const { token } = await issueSession({ sessions, jwtSecret }, "alice", { provider: "test" });
    const get = { name: "taskService_get", arguments: { id: "t1" } };
    expect(await invoke(url, get, { token })).toMatchObject({
      status: 200,
      body: { success: true },
    });
    sessions.revokeAll("alice");
    expect(await invoke(url, get, { token })).toMatchObject({
      status: 401,
      body: { code: "UNAUTHENTICATED" },
    });
    const sessionless = await createJWT({ userId: "alice" }, jwtSecret);
    expect(await invoke(url, get, { token: sessionless })).toMatchObject({ status: 401 });
  });
});

describe("a request that goes away", () => {
  it("cancels its call", async () => {
    const { router, services, records } = routes();
    const url = await listen(router);
    const controller = new AbortController();
    const pending = invoke(
      url,
      { name: "noteService_wait", arguments: { key: "http" } },
      {
        signal: controller.signal,
      },
    ).catch((error: unknown) => error);
    await vi.waitFor(() => expect(services.signals.has("http")).toBe(true));
    controller.abort();
    await vi.waitFor(() => expect(services.signals.get("http")?.aborted).toBe(true));
    expect(await pending).toBeInstanceOf(Error);
    await vi.waitFor(() => expect(records.map((record) => record.outcome)).toEqual(["CANCELLED"]));
  });
});

describe("the path option", () => {
  it("moves the routes under another prefix", async () => {
    const { router } = routes({ path: "/agents/" });
    const url = await listen(router);
    expect((await fetch(`${url}/agents/tools`)).status).toBe(200);
    expect(
      await invoke(
        url,
        { name: "noteService_search", arguments: { input: "x" } },
        { path: "/agents/invoke" },
      ),
    ).toMatchObject({ status: 200, body: { success: true } });
    expect((await fetch(`${url}/mcp/tools`)).status).toBe(404);
  });
});
