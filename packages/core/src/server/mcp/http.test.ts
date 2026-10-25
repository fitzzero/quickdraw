// The MCP HTTP routes (RFC 0003 section 10): 4.1's `GET /mcp/tools` and
// `POST /mcp/invoke` over the registry, on Express 4, Express 5 and a bare
// Node server, authenticated by bearer token through the registry's
// `principal` hook; then the Streamable HTTP endpoint at `/mcp` itself, with
// hand-written JSON-RPC requests, each test on a bare Node server and on
// Express 5.

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
import type { HttpRouter } from "../transports/http";
import { QUICKDRAW_VERSION } from "../../version";
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

describe("a principal hook that cannot check the token (an outage)", () => {
  it("answers 500 INTERNAL, logged once as an error, where a token it refuses answers 401", async () => {
    let storeDown = false;
    const tokens = agentAuth((request) => (request.transport === "http" ? request.token : null));
    const fixture = setup({
      ...tokens,
      principal: (request) => {
        if (storeDown) {
          throw new Error("the token store is down");
        }
        return tokens.principal(request);
      },
    });
    const url = await listen(
      createMcpHttpRouter({ registry: fixture.registry, logger: fixture.logger }),
    );
    const call = { name: "taskService_whoami", arguments: {} };
    expect(await invoke(url, call, { token: "stolen-token" })).toEqual({
      status: 401,
      body: { success: false, error: "Authentication failed", code: "UNAUTHENTICATED" },
    });
    storeDown = true;
    // A good token the hook could not check: the agent is not told to drop it.
    expect(await invoke(url, call, { token: "writer-token" })).toEqual({
      status: 500,
      body: { success: false, error: "Internal error", code: "INTERNAL" },
    });
    expect(
      await invoke(url, { service: "taskService", method: "whoami" }, { token: "writer-token" }),
    ).toMatchObject({ status: 500, body: { code: "INTERNAL" } });
    expect(fixture.logger.at("debug").map((entry) => entry.message)).toEqual([
      "MCP authentication failed",
    ]);
    expect(fixture.logger.at("error").map((entry) => entry.message)).toEqual([
      "MCP authentication failed",
      "MCP authentication failed",
    ]);
    expect(fixture.records).toEqual([]);
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

describe("a principal in the request body", () => {
  it("is never read: the registry's principal hook says who calls, in both shapes", async () => {
    const { router } = routes();
    const url = await listen(router);
    const mallory = { userId: "mallory", kind: "user", serviceAccess: { taskService: "Admin" } };
    const tool = { name: "taskService_whoami", arguments: {}, principal: mallory };
    const method = { service: "taskService", method: "whoami", principal: mallory };
    for (const body of [tool, method]) {
      expect(await invoke(url, body)).toMatchObject({
        status: 200,
        body: { success: true, data: { userId: null } },
      });
      expect(await invoke(url, body, { token: "reader-token" })).toMatchObject({
        status: 200,
        body: { success: true, data: { userId: "alice", kind: "agent" } },
      });
    }
  });
});

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

// The Streamable HTTP endpoint at `/mcp` itself: hand-written JSON-RPC
// requests, as an MCP client's Streamable HTTP transport sends them.

/** What a client of the Streamable HTTP transport sends as `Accept`. */
const ACCEPT = "application/json, text/event-stream";

interface RpcAnswer {
  readonly status: number;
  readonly headers: Headers;
  readonly body: unknown;
}

/** POSTs a body of JSON-RPC messages (or `body` as it is, when it is a string) to the endpoint. */
async function rpc(
  url: string,
  body: unknown,
  options: {
    readonly token?: string;
    readonly version?: string;
    readonly headers?: Readonly<Record<string, string>>;
    readonly signal?: AbortSignal;
    readonly path?: string;
  } = {},
): Promise<RpcAnswer> {
  const response = await fetch(`${url}${options.path ?? "/mcp"}`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      accept: ACCEPT,
      ...(options.version === undefined ? {} : { "mcp-protocol-version": options.version }),
      ...(options.token === undefined ? {} : { authorization: `Bearer ${options.token}` }),
      ...options.headers,
    },
    body: typeof body === "string" ? body : JSON.stringify(body),
    signal: options.signal,
  });
  const text = await response.text();
  return {
    status: response.status,
    headers: response.headers,
    body: text === "" ? undefined : (JSON.parse(text) as unknown),
  };
}

function rpcRequest(id: number | string | null, method: string, params?: unknown) {
  return params === undefined
    ? { jsonrpc: "2.0", id, method }
    : { jsonrpc: "2.0", id, method, params };
}

function toolCall(id: number | string, name: string, args?: unknown) {
  return rpcRequest(id, "tools/call", args === undefined ? { name } : { name, arguments: args });
}

const INITIALIZED = { jsonrpc: "2.0", method: "notifications/initialized" };

/** A `tools/call` response's value (or error), from its one text block, and whether it is an error. */
function outcomeOf(response: unknown): { readonly isError: boolean; readonly value: unknown } {
  const { result } = response as {
    result: { content: { type: string; text: string }[]; isError?: boolean };
  };
  expect(result.content).toHaveLength(1);
  expect(result.content[0]?.type).toBe("text");
  return {
    isError: result.isError === true,
    value: JSON.parse(result.content[0]?.text ?? "") as unknown,
  };
}

/** Where each test of the endpoint runs: a bare Node server, and an Express 5 app without a JSON parser. */
const HOSTS: readonly (readonly [string, (router: HttpRouter) => RequestListener])[] = [
  ["a bare Node server", (router) => router],
  [
    "an Express 5 app",
    (router) => {
      const app = express5();
      app.use(router);
      return app;
    },
  ],
];

describe.each(HOSTS)("the Streamable HTTP endpoint on %s", (_host, host) => {
  async function serve(
    options: Omit<McpHttpRouterOptions, "registry"> = {},
    pipeline: PipelineOptions = {},
  ) {
    const fixture = routes(options, pipeline);
    return { ...fixture, url: await listen(host(fixture.router)) };
  }

  it("initializes with the client's version when it speaks it, else the latest, and keeps no session", async () => {
    const { url } = await serve();
    const init = (protocolVersion: unknown, headers?: Readonly<Record<string, string>>) =>
      rpc(
        url,
        rpcRequest(1, "initialize", {
          protocolVersion,
          capabilities: {},
          clientInfo: { name: "t", version: "1" },
        }),
        { headers },
      );
    const first = await init("2025-06-18");
    expect(first.status).toBe(200);
    expect(first.body).toEqual({
      jsonrpc: "2.0",
      id: 1,
      result: {
        protocolVersion: "2025-06-18",
        serverInfo: { name: "quickdraw", version: QUICKDRAW_VERSION },
        capabilities: { tools: {} },
      },
    });
    expect(first.headers.get("content-type")).toBe("application/json; charset=utf-8");
    expect(first.headers.get("cache-control")).toBe("no-store");
    expect(first.headers.get("x-content-type-options")).toBe("nosniff");
    expect(first.headers.get("mcp-session-id")).toBeNull();
    const versionOf = async (requested: unknown, headers?: Readonly<Record<string, string>>) =>
      ((await init(requested, headers)).body as { result: { protocolVersion: string } }).result
        .protocolVersion;
    expect(await versionOf("2025-11-25")).toBe("2025-11-25");
    expect(await versionOf("2025-03-26")).toBe("2025-03-26");
    expect(await versionOf("2024-11-05")).toBe("2025-11-25");
    expect(await versionOf(undefined)).toBe("2025-11-25");
    // initialize negotiates in its body: its own MCP-Protocol-Version is not read
    expect(await versionOf("2025-06-18", { "mcp-protocol-version": "2024-11-05" })).toBe(
      "2025-06-18",
    );
    // a session id a client sends is ignored, and none is sent back
    const withSession = await init("2025-11-25", { "mcp-session-id": "made-up" });
    expect(withSession.status).toBe(200);
    expect(withSession.headers.get("mcp-session-id")).toBeNull();
  });

  it("answers notifications and responses with 202 and no body", async () => {
    const { url } = await serve();
    const initialized = await rpc(url, INITIALIZED, { version: "2025-11-25" });
    expect(initialized.status).toBe(202);
    expect(initialized.body).toBeUndefined();
    expect(initialized.headers.get("content-type")).toBeNull();
    expect(initialized.headers.get("mcp-session-id")).toBeNull();
    // a cancel names a request of another POST, which a stateless server cannot find
    const cancel = { jsonrpc: "2.0", method: "notifications/cancelled", params: { requestId: 1 } };
    expect(await rpc(url, cancel)).toMatchObject({ status: 202, body: undefined });
    expect(await rpc(url, { jsonrpc: "2.0", id: 5, result: {} })).toMatchObject({
      status: 202,
      body: undefined,
    });
  });

  it("lists the tools, and calls one as the bearer token's principal over transport mcp", async () => {
    const { url, records } = await serve();
    const list = await rpc(url, rpcRequest(2, "tools/list"), { version: "2025-11-25" });
    expect(list.status).toBe(200);
    const { tools } = (list.body as { result: { tools: { name: string }[] } }).result;
    expect(tools.map((tool) => tool.name)).toEqual([
      "taskService_get",
      "taskService_list",
      "taskService_rename",
      "taskService_whoami",
      "noteService_search",
      "noteService_archive",
      "noteService_wait",
    ]);
    expect((await rpc(url, rpcRequest("p", "ping"))).body).toEqual({
      jsonrpc: "2.0",
      id: "p",
      result: {},
    });
    const who = await rpc(url, toolCall(3, "taskService_whoami", {}), {
      token: "reader-token",
      version: "2025-11-25",
    });
    expect(who.status).toBe(200);
    expect((who.body as { id: unknown }).id).toBe(3);
    expect(outcomeOf(who.body)).toEqual({
      isError: false,
      value: { userId: "alice", kind: "agent", transport: "mcp", scopes: ["tasks:read"] },
    });
    // no token is anonymous
    expect(outcomeOf((await rpc(url, toolCall(4, "taskService_whoami", {}))).body)).toEqual({
      isError: false,
      value: { userId: null, kind: null, transport: "mcp", scopes: [] },
    });
    expect(records.map((record) => [record.method, record.transport, record.outcome])).toEqual([
      ["whoami", "mcp", "ok"],
      ["whoami", "mcp", "ok"],
    ]);
    expect(records[0]?.bytes).toBeGreaterThan(0);
  });

  it("answers a refused call as a tool error with its code, as stdio does", async () => {
    const { url, logger } = await serve();
    const outcome = async (call: unknown, token?: string) =>
      outcomeOf((await rpc(url, call, { token })).body);
    expect(
      await outcome(
        toolCall(1, "taskService_rename", { id: "t1", title: "Ship it" }),
        "reader-token",
      ),
    ).toEqual({ isError: true, value: { code: "FORBIDDEN", message: "Insufficient permissions" } });
    expect(await outcome(toolCall(2, "taskService_get", {}), "writer-token")).toMatchObject({
      isError: true,
      value: { code: "VALIDATION", data: { issues: [{ path: ["id"] }] } },
    });
    expect(await outcome(toolCall(3, "taskService_get", { id: "t1" }))).toEqual({
      isError: true,
      value: { code: "UNAUTHENTICATED", message: "Authentication required" },
    });
    // a token the principal hook refuses: logged at debug, never with the token (MCP-7)
    expect(await outcome(toolCall(4, "taskService_whoami", {}), "stolen-token")).toEqual({
      isError: true,
      value: { code: "UNAUTHENTICATED", message: "Authentication failed" },
    });
    expect(logger.at("error")).toEqual([]);
    expect(logger.at("debug").map((entry) => entry.message)).toContain("MCP authentication failed");
    expect(JSON.stringify(logger.entries)).not.toContain("stolen-token");
  });

  it("answers a principal hook that cannot check the token INTERNAL, logged once as an error", async () => {
    let storeDown = false;
    const tokens = agentAuth((request) => (request.transport === "http" ? request.token : null));
    const fixture = setup({
      ...tokens,
      principal: (request) => {
        if (storeDown) {
          throw new Error("the token store is down");
        }
        return tokens.principal(request);
      },
    });
    const url = await listen(
      host(createMcpHttpRouter({ registry: fixture.registry, logger: fixture.logger })),
    );
    const call = toolCall(1, "taskService_whoami", {});
    expect(outcomeOf((await rpc(url, call, { token: "stolen-token" })).body)).toEqual({
      isError: true,
      value: { code: "UNAUTHENTICATED", message: "Authentication failed" },
    });
    storeDown = true;
    // a good token the hook could not check: the agent is not told to drop it
    expect(outcomeOf((await rpc(url, call, { token: "writer-token" })).body)).toEqual({
      isError: true,
      value: { code: "INTERNAL", message: "Internal error" },
    });
    expect(fixture.logger.at("debug").map((entry) => entry.message)).toEqual([
      "MCP authentication failed",
    ]);
    expect(fixture.logger.at("error").map((entry) => entry.message)).toEqual([
      "MCP authentication failed",
    ]);
    expect(fixture.records).toEqual([]);
  });

  it("answers protocol errors with JSON-RPC's codes: -32601, -32602, -32700 and -32600", async () => {
    const { url } = await serve();
    expect(await rpc(url, rpcRequest(6, "resources/list"))).toMatchObject({
      status: 200,
      body: {
        jsonrpc: "2.0",
        id: 6,
        error: { code: -32601, message: "Method not found: resources/list" },
      },
    });
    expect((await rpc(url, rpcRequest(7, "tools/call", { arguments: {} }))).body).toEqual({
      jsonrpc: "2.0",
      id: 7,
      error: { code: -32602, message: "tools/call needs params { name, arguments? }" },
    });
    expect((await rpc(url, toolCall(8, "nope", {}))).body).toEqual({
      jsonrpc: "2.0",
      id: 8,
      error: { code: -32602, message: "Unknown tool: nope" },
    });
    expect(await rpc(url, '{"jsonrpc":')).toMatchObject({
      status: 400,
      body: {
        jsonrpc: "2.0",
        id: null,
        error: { code: -32700, message: "The request body is not valid JSON" },
      },
    });
    expect(await rpc(url, "")).toMatchObject({
      status: 400,
      body: { id: null, error: { code: -32700 } },
    });
    // one message that is no JSON-RPC message
    const invalid = {
      jsonrpc: "2.0",
      id: null,
      error: { code: -32600, message: "Invalid Request" },
    };
    expect(await rpc(url, 42)).toMatchObject({ status: 400, body: invalid });
    expect(await rpc(url, { jsonrpc: "2.0", id: null, method: "ping" })).toMatchObject({
      status: 400,
      body: invalid,
    });
    expect(await rpc(url, { jsonrpc: "2.0", id: 9 })).toMatchObject({
      status: 400,
      body: { ...invalid, id: 9 },
    });
  });

  it("refuses a body without Content-Type: application/json (415) and a client that accepts no JSON (406)", async () => {
    const { url, records } = await serve();
    const post = (headers: Readonly<Record<string, string>>) =>
      fetch(`${url}/mcp`, { method: "POST", headers, body: JSON.stringify(rpcRequest(1, "ping")) });
    const plain = await post({ "content-type": "text/plain", accept: ACCEPT });
    expect(plain.status).toBe(415);
    expect(await plain.json()).toEqual({
      jsonrpc: "2.0",
      id: null,
      error: {
        code: -32000,
        message: "Send the messages as a JSON body with Content-Type: application/json",
      },
    });
    for (const accept of [
      "text/html",
      "text/event-stream",
      "application/json;q=0, */*",
      "application/*;q=0",
    ]) {
      const refused = await post({ "content-type": "application/json", accept });
      expect(refused.status).toBe(406);
      expect(await refused.json()).toEqual({
        jsonrpc: "2.0",
        id: null,
        error: {
          code: -32000,
          message: "Accept application/json: the endpoint answers with JSON, never a stream",
        },
      });
    }
    for (const accept of [
      ACCEPT,
      "application/json",
      "application/*",
      "*/*",
      "text/html, */*;q=0.1",
    ]) {
      expect((await post({ "content-type": "application/json", accept })).status).toBe(200);
    }
    expect(records).toEqual([]);
  });

  it("checks MCP-Protocol-Version: 400 for one it does not speak, and 2025-03-26 without one", async () => {
    const { url, records } = await serve();
    for (const version of ["2024-11-05", "2026-01-01", "latest"]) {
      expect(
        await rpc(url, toolCall(1, "noteService_search", { input: "x" }), { version }),
      ).toMatchObject({
        status: 400,
        body: {
          jsonrpc: "2.0",
          id: null,
          error: {
            code: -32000,
            message:
              "Unsupported MCP-Protocol-Version: the endpoint speaks 2025-11-25, 2025-06-18, 2025-03-26",
          },
        },
      });
    }
    expect((await rpc(url, INITIALIZED, { version: "2024-11-05" })).status).toBe(400);
    expect(records).toEqual([]);
    for (const version of [undefined, "2025-03-26", "2025-06-18", "2025-11-25"]) {
      expect((await rpc(url, rpcRequest(1, "tools/list"), { version })).status).toBe(200);
    }
  });

  it("answers a batch under 2025-03-26 with an array of its responses, in its order", async () => {
    const { url, records } = await serve();
    const batch = [
      rpcRequest(1, "ping"),
      INITIALIZED,
      toolCall(2, "noteService_search", { input: "rfc" }),
      rpcRequest(3, "resources/list"),
      42,
      { jsonrpc: "2.0", id: 9, result: {} },
      rpcRequest(4, "tools/list"),
    ];
    // without MCP-Protocol-Version, as a 2025-03-26 client sends it, and with it
    for (const version of [undefined, "2025-03-26"]) {
      const answer = await rpc(url, batch, { version });
      expect(answer.status).toBe(200);
      const responses = answer.body as Record<string, unknown>[];
      expect(responses.map((response) => response.id)).toEqual([1, 2, 3, null, 4]);
      expect(responses[0]).toEqual({ jsonrpc: "2.0", id: 1, result: {} });
      expect(outcomeOf(responses[1])).toEqual({ isError: false, value: ["a note about rfc"] });
      expect(responses[2]).toMatchObject({ error: { code: -32601 } });
      expect(responses[3]).toEqual({
        jsonrpc: "2.0",
        id: null,
        error: { code: -32600, message: "Invalid Request" },
      });
      expect(responses[4]).toMatchObject({ result: { tools: expect.any(Array) } });
    }
    expect(records.map((record) => record.outcome)).toEqual(["ok", "ok"]);
    // notifications and responses only
    expect(await rpc(url, [INITIALIZED, { jsonrpc: "2.0", id: 9, result: {} }])).toMatchObject({
      status: 202,
      body: undefined,
    });
  });

  it("refuses a batch under a later version, an empty or long one, and one with two tool calls, running none of it", async () => {
    const { url, records, services } = await serve();
    const pings = (count: number) =>
      Array.from({ length: count }, (_, id) => rpcRequest(id, "ping"));
    for (const version of ["2025-06-18", "2025-11-25"]) {
      expect(await rpc(url, pings(2), { version })).toMatchObject({
        status: 400,
        body: {
          jsonrpc: "2.0",
          id: null,
          error: {
            code: -32600,
            message: `MCP protocol version ${version} takes one message per request, never a batch`,
          },
        },
      });
    }
    const tooLong = {
      status: 400,
      body: { id: null, error: { code: -32600, message: "A batch holds from 1 to 16 messages" } },
    };
    expect(await rpc(url, [])).toMatchObject(tooLong);
    expect(await rpc(url, pings(17))).toMatchObject(tooLong);
    // a huge batch is refused by its length, before any message is read
    expect(await rpc(url, pings(10_000))).toMatchObject(tooLong);
    expect(((await rpc(url, pings(16))).body as unknown[]).length).toBe(16);
    // a rate limit in front of the route counts a POST once: one call per POST, batch or not
    const twoCalls = [
      toolCall(1, "noteService_wait", { key: "one" }),
      toolCall(2, "noteService_wait", { key: "two" }),
    ];
    expect(await rpc(url, twoCalls)).toMatchObject({
      status: 400,
      body: {
        id: null,
        error: {
          code: -32600,
          message:
            "A batch holds at most one tools/call: send each other call in a request of its own",
        },
      },
    });
    expect(services.gates.size).toBe(0);
    expect(records).toEqual([]);
  });

  it("reads deeply nested JSON as data, never walking it", async () => {
    const { url } = await serve();
    const deep = `${"[".repeat(100_000)}${"]".repeat(100_000)}`;
    const call = `{"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"name":"noteService_search","arguments":{"input":${deep}}}}`;
    const answer = await rpc(url, call);
    expect(answer.status).toBe(200);
    expect(outcomeOf(answer.body)).toMatchObject({ isError: true, value: { code: "VALIDATION" } });
    // a batch of one message that is an array
    expect(await rpc(url, deep)).toMatchObject({
      status: 200,
      body: [{ id: null, error: { code: -32600, message: "Invalid Request" } }],
    });
  });

  it("answers GET and DELETE with 405 and Allow: POST, and passes on every other method", async () => {
    const { url } = await serve();
    for (const method of ["GET", "DELETE"]) {
      const response = await fetch(`${url}/mcp`, {
        method,
        headers: { accept: "text/event-stream", "mcp-session-id": "made-up" },
      });
      expect(response.status).toBe(405);
      expect(response.headers.get("allow")).toBe("POST");
      expect(response.headers.get("mcp-session-id")).toBeNull();
      expect(await response.json()).toEqual({
        jsonrpc: "2.0",
        id: null,
        error: {
          code: -32000,
          message: "The MCP endpoint takes POST: it opens no event stream and keeps no session",
        },
      });
    }
    expect((await fetch(`${url}/mcp`, { method: "PUT" })).status).toBe(404);
  });

  it("refuses a web page's Origin with 403 unless allowedOrigins lists it, and a Host allowedHosts does not list (MCP-3)", async () => {
    const { url } = await serve();
    const ping = rpcRequest(1, "ping");
    const attacker = { origin: "http://attacker.example" };
    expect(await raw(url, { method: "POST", path: "/mcp", headers: attacker, body: ping })).toEqual(
      {
        status: 403,
        body: {
          jsonrpc: "2.0",
          id: null,
          error: {
            code: -32000,
            message:
              "The MCP routes refuse requests from web pages unless allowedOrigins lists their origin",
          },
        },
      },
    );
    expect(await raw(url, { method: "GET", path: "/mcp", headers: attacker })).toMatchObject({
      status: 403,
    });
    // no Origin (an MCP client), and no Accept: answered
    expect(await raw(url, { method: "POST", path: "/mcp", body: ping })).toEqual({
      status: 200,
      body: { jsonrpc: "2.0", id: 1, result: {} },
    });
    const listed = await serve({
      allowedOrigins: ["http://app.example"],
      allowedHosts: ["127.0.0.1"],
    });
    const post = (headers: Readonly<Record<string, string>>) =>
      raw(listed.url, { method: "POST", path: "/mcp", headers, body: ping });
    expect(await post({ origin: "http://app.example" })).toMatchObject({ status: 200 });
    expect(await post({ origin: "http://other.example" })).toMatchObject({ status: 403 });
    expect(await post({ host: "attacker.example:4000" })).toMatchObject({
      status: 403,
      body: { error: { code: -32000, message: "The MCP routes do not answer for this host" } },
    });
  });

  it("cancels a call whose client goes away", async () => {
    const { url, services, records } = await serve();
    const controller = new AbortController();
    const pending = rpc(url, toolCall(1, "noteService_wait", { key: "gone" }), {
      signal: controller.signal,
    }).catch((error: unknown) => error);
    await vi.waitFor(() => expect(services.signals.has("gone")).toBe(true));
    controller.abort();
    await vi.waitFor(() => expect(services.signals.get("gone")?.aborted).toBe(true));
    expect(await pending).toBeInstanceOf(Error);
    await vi.waitFor(() => expect(records.map((record) => record.outcome)).toEqual(["CANCELLED"]));
  });

  it("holds its calls in the caller's lane, the lane invoke's calls share (MCP-4)", async () => {
    const { url, services } = await serve(
      {},
      { limits: { maxInFlightQueries: 1, maxQueuedQueries: 0 } },
    );
    const held = rpc(url, toolCall(1, "noteService_wait", { key: "lane" }));
    await vi.waitFor(() => expect(services.gates.has("lane")).toBe(true));
    const search = toolCall(2, "noteService_search", { input: "x" });
    expect(outcomeOf((await rpc(url, search)).body)).toMatchObject({
      isError: true,
      value: { code: "RATE_LIMITED" },
    });
    expect(
      await invoke(url, { name: "noteService_search", arguments: { input: "x" } }),
    ).toMatchObject({ status: 429, body: { code: "RATE_LIMITED" } });
    services.gates.get("lane")?.resolve("A");
    expect(outcomeOf((await held).body)).toEqual({ isError: false, value: "A" });
    expect(outcomeOf((await rpc(url, search)).body)).toEqual({
      isError: false,
      value: ["a note about x"],
    });
  });

  it("reads the body within maxBodyBytes, as invoke does", async () => {
    const { url, records } = await serve({ maxBodyBytes: 64 });
    expect(
      await rpc(url, toolCall(1, "noteService_search", { input: "x".repeat(80) })),
    ).toMatchObject({
      status: 400,
      body: {
        jsonrpc: "2.0",
        id: null,
        error: { code: -32700, message: "The request body is larger than 64 bytes" },
      },
    });
    expect(records).toEqual([]);
    expect((await rpc(url, rpcRequest(1, "ping"))).status).toBe(200);
  });

  it("never reads a principal from the message: the principal hook says who calls", async () => {
    const { url } = await serve();
    const mallory = { userId: "mallory", kind: "user", serviceAccess: { taskService: "Admin" } };
    const call = {
      ...rpcRequest(1, "tools/call", {
        name: "taskService_whoami",
        arguments: {},
        principal: mallory,
      }),
      principal: mallory,
    };
    expect(outcomeOf((await rpc(url, call)).body).value).toMatchObject({ userId: null });
    expect(outcomeOf((await rpc(url, call, { token: "reader-token" })).body).value).toMatchObject({
      userId: "alice",
      kind: "agent",
    });
  });

  it("leaves 4.1's routes answering below it", async () => {
    const { url } = await serve();
    await expectRoutes(url);
  });
});

describe("the Streamable HTTP endpoint behind the app's JSON parser", () => {
  it("answers the body express.json() read, one message or a batch", async () => {
    const { router } = routes();
    const app = express();
    app.use(express.json());
    app.use(router);
    const url = await listen(app);
    const got = await rpc(url, toolCall(1, "taskService_get", { id: "t1" }), {
      token: "reader-token",
    });
    expect(outcomeOf(got.body)).toEqual({
      isError: false,
      value: { id: "t1", title: "Write the RFC", done: false },
    });
    expect((await rpc(url, [rpcRequest(1, "ping"), rpcRequest(2, "ping")])).body).toEqual([
      { jsonrpc: "2.0", id: 1, result: {} },
      { jsonrpc: "2.0", id: 2, result: {} },
    ]);
    expect((await rpc(url, INITIALIZED)).status).toBe(202);
  });
});

describe("the Streamable HTTP endpoint's options", () => {
  it("names the server in initialize, and moves with the path option", async () => {
    const { registry } = setup();
    const url = await listen(
      createMcpHttpRouter({ registry, path: "/agents/", name: "my-app", version: "1.2.3" }),
    );
    expect((await rpc(url, rpcRequest(1, "initialize", {}), { path: "/agents" })).body).toEqual({
      jsonrpc: "2.0",
      id: 1,
      result: {
        protocolVersion: "2025-11-25",
        serverInfo: { name: "my-app", version: "1.2.3" },
        capabilities: { tools: {} },
      },
    });
    expect((await rpc(url, rpcRequest(1, "ping"))).status).toBe(404);
    // at "/", the endpoint is the root, beside /tools and /invoke
    const root = await listen(createMcpHttpRouter({ registry, path: "/" }));
    expect((await rpc(root, rpcRequest(1, "ping"), { path: "/" })).status).toBe(200);
    expect((await fetch(`${root}/tools`)).status).toBe(200);
    expect(() => createMcpHttpRouter({ registry, name: 1 } as never)).toThrow(
      "createMcpHttpRouter: name and version must be strings, for serverInfo",
    );
  });
});
