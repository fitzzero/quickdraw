// The MCP HTTP routes (RFC 0003 section 10): 4.1's `GET /mcp/tools` and
// `POST /mcp/invoke` over the registry, on Express 4, Express 5 and a bare
// Node server, authenticated by bearer token through the registry's
// `principal` hook.

import { createServer as createHttpServer, type RequestListener, type Server } from "node:http";
import { createRequire } from "node:module";
import type { AddressInfo } from "node:net";
import express from "express";
import { afterEach, describe, expect, it, vi } from "vitest";
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
function routes(options: Omit<McpHttpRouterOptions, "registry"> = {}) {
  const fixture = setup(
    agentAuth((request) => (request.transport === "http" ? request.token : null)),
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
    expect(logger.at("error").map((entry) => entry.message)).toEqual(["MCP authentication failed"]);
    expect(() => createMcpHttpRouter({ registry: setup().registry, maxBodyBytes: 0 })).toThrow(
      "createMcpHttpRouter: maxBodyBytes must be a whole number of bytes, 1 or more",
    );
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
