// The MCP registry (RFC 0003 section 10): every method's tool call goes
// through the dispatcher with transport "mcp", so validation, access checks
// and the per-session concurrency cap apply as on a socket; the principal and
// `ctx.mcp` come from the registry's hooks; custom tools sit beside the
// generated ones.

import { describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { z as z3 } from "zod3";
import { defineContract, query, QuickdrawError } from "../../index";
import { createDispatcher } from "../index";
import { agentAuth, createServices, qd, setup, TOKENS, type AgentMcp } from "./__tests__/fixtures";
import {
  createMcpRegistry,
  toToolResult,
  type McpCallResult,
  type McpRequest,
  type McpStdioRequest,
} from "./index";

const stdio = (sessionId = "s1"): McpStdioRequest => ({ transport: "stdio", sessionId });

function errorOf(result: McpCallResult): QuickdrawError {
  if (result.ok) {
    throw new Error(`expected a failure, got ${JSON.stringify(result)}`);
  }
  return result.error;
}

describe("a method's tool", () => {
  it("calls through the dispatcher as an MCP call, with the mapped principal and ctx.mcp", async () => {
    const { registry, records } = setup();
    const result = await registry.call("taskService_whoami", {}, { request: stdio() });
    expect(result).toEqual({
      ok: true,
      data: {
        userId: "alice",
        kind: "agent",
        transport: "mcp",
        scopes: ["tasks:read", "tasks:write"],
      },
    });
    expect(records.map((record) => [record.service, record.method, record.transport])).toEqual([
      ["taskService", "whoami", "mcp"],
    ]);
  });

  it("answers FORBIDDEN as a tool error that carries the code", async () => {
    const { registry, records } = setup(agentAuth(() => "reader-token"));
    const result = await registry.call(
      "taskService_rename",
      { id: "t1", title: "Ship it" },
      { request: stdio() },
    );
    expect(errorOf(result).code).toBe("FORBIDDEN");
    expect(toToolResult(result)).toEqual({
      content: [
        {
          type: "text",
          text: JSON.stringify({ code: "FORBIDDEN", message: "Insufficient permissions" }, null, 2),
        },
      ],
      isError: true,
    });
    expect(records.map((record) => record.outcome)).toEqual(["FORBIDDEN"]);
  });

  it("validates the input like any call, whatever the MCP client checked", async () => {
    const { registry } = setup();
    const error = errorOf(
      await registry.call("taskService_rename", { id: 7, title: "" }, { request: stdio() }),
    );
    expect(error.code).toBe("VALIDATION");
    expect(error.data).toEqual({
      issues: [
        { path: ["id"], message: expect.any(String) },
        { path: ["title"], message: expect.any(String) },
      ],
    });
  });

  it("maps arguments onto object, wrapped and absent inputs", async () => {
    const { registry } = setup();
    const call = (name: string, args: unknown) => registry.call(name, args, { request: stdio() });
    expect(await call("taskService_list", undefined)).toMatchObject({
      ok: true,
      data: [{ id: "t0" }, { id: "t1" }],
    });
    expect(await call("noteService_search", { input: "rfc" })).toEqual({
      ok: true,
      data: ["a note about rfc"],
    });
    expect(await call("noteService_archive", { input: { by: "tag", tag: "x" } })).toEqual({
      ok: true,
      data: 3,
    });
    expect(errorOf(await call("noteService_search", { query: "rfc" })).code).toBe("VALIDATION");
    expect(await call("taskService_whoami", { ignored: true })).toMatchObject({ ok: true });
  });

  it("passes a handler's error code through, and keeps an internal error's message generic", async () => {
    const { registry } = setup();
    const conflict = await registry.call(
      "noteService_archive",
      { input: { by: "tag", tag: "locked" } },
      { request: stdio() },
    );
    expect(toToolResult(conflict).content[0]?.text).toContain('"code": "CONFLICT"');
    expect(errorOf(conflict).message).toBe("Notes tagged locked cannot be archived");
  });

  it("calls a method's tool by service and method with the input as it is", async () => {
    const { registry } = setup({ exclude: ["noteService.wait"] });
    expect(await registry.callMethod("noteService", "search", "rfc", { request: stdio() })).toEqual(
      { ok: true, data: ["a note about rfc"] },
    );
    const excluded = await registry.callMethod(
      "noteService",
      "wait",
      { key: "k" },
      {
        request: stdio(),
      },
    );
    expect(errorOf(excluded)).toMatchObject({
      code: "NOT_FOUND",
      message: "noteService.wait is not an MCP tool",
    });
  });
});

describe("sessions", () => {
  it("counts a session's queries against one connection, like a socket", async () => {
    const { registry, services } = setup(
      {},
      { limits: { maxInFlightQueries: 1, maxQueuedQueries: 0 } },
    );
    const first = registry.call("noteService_wait", { key: "a" }, { request: stdio("s1") });
    await vi.waitFor(() => expect(services.gates.has("a")).toBe(true));
    const sameSession = await registry.call(
      "noteService_wait",
      { key: "b" },
      { request: stdio("s1") },
    );
    expect(errorOf(sameSession)).toMatchObject({
      code: "RATE_LIMITED",
      data: { retryAfterMs: 1000 },
    });
    const otherSession = registry.call("noteService_wait", { key: "c" }, { request: stdio("s2") });
    await vi.waitFor(() => expect(services.gates.has("c")).toBe(true));
    services.gates.get("a")?.resolve("A");
    services.gates.get("c")?.resolve("C");
    expect(await first).toEqual({ ok: true, data: "A" });
    expect(await otherSession).toEqual({ ok: true, data: "C" });
  });

  it("cancels a query when the call's signal aborts", async () => {
    const { registry, services } = setup();
    const controller = new AbortController();
    const pending = registry.call(
      "noteService_wait",
      { key: "k" },
      {
        request: stdio(),
        signal: controller.signal,
      },
    );
    await vi.waitFor(() => expect(services.signals.has("k")).toBe(true));
    controller.abort();
    expect(errorOf(await pending).code).toBe("CANCELLED");
    expect(services.signals.get("k")?.aborted).toBe(true);
  });

  it("asks principal and context on every call, with the request they arrived on", async () => {
    const seen: McpRequest[] = [];
    const { registry } = setup({
      principal: (request) => {
        seen.push(request);
        return { userId: "bob", kind: "user" };
      },
      context: (request, principal) => ({ scopes: [request.sessionId, principal?.userId ?? ""] }),
    });
    expect(await registry.call("taskService_whoami", {}, { request: stdio("s9") })).toMatchObject({
      ok: true,
      data: { userId: "bob", kind: "user", scopes: ["s9", "bob"] },
    });
    expect(seen).toEqual([stdio("s9")]);
  });

  it("answers UNAUTHENTICATED when principal fails, and lets an anonymous caller call public methods only", async () => {
    const { registry, logger } = setup(agentAuth(() => "stolen-token"));
    const refused = await registry.call("taskService_list", {}, { request: stdio() });
    expect(errorOf(refused)).toMatchObject({
      code: "UNAUTHENTICATED",
      message: "Authentication failed",
    });
    expect(logger.at("error").map((entry) => entry.message)).toEqual(["MCP authentication failed"]);
    const anonymous = setup({ principal: () => null, context: undefined }).registry;
    expect(await anonymous.call("taskService_whoami", {}, { request: stdio() })).toMatchObject({
      ok: true,
      data: { userId: null, scopes: null },
    });
    const get = await anonymous.call("taskService_get", { id: "t1" }, { request: stdio() });
    expect(errorOf(get).code).toBe("UNAUTHENTICATED");
  });

  it("fails a call with INTERNAL when context throws or returns something other than fields", async () => {
    const { registry, logger } = setup({
      context: () => {
        throw new Error("the token service is down");
      },
    });
    const thrown = await registry.call("taskService_whoami", {}, { request: stdio() });
    expect(errorOf(thrown)).toMatchObject({ code: "INTERNAL", message: "Internal error" });
    expect(logger.at("error")[0]?.message).toBe('The MCP tool "taskService_whoami" failed');
    const odd = setup({ context: () => "scopes" as unknown as AgentMcp }).registry;
    expect(errorOf(await odd.call("taskService_whoami", {}, { request: stdio() })).code).toBe(
      "INTERNAL",
    );
  });

  it("hands the result to respond once, before the call resolves", async () => {
    const { registry } = setup();
    const respond = vi.fn(() => 12);
    const result = await registry.call(
      "noteService_search",
      { input: "x" },
      {
        request: stdio(),
        respond,
      },
    );
    expect(respond).toHaveBeenCalledExactlyOnceWith(result);
    const unknown = await registry.call("nope", {}, { request: stdio(), respond });
    expect(errorOf(unknown)).toMatchObject({ code: "NOT_FOUND", message: 'Unknown tool "nope"' });
    expect(respond).toHaveBeenLastCalledWith(unknown);
    expect(registry.has("noteService_search")).toBe(true);
    expect(registry.has("nope")).toBe(false);
  });
});

describe("custom tools", () => {
  const summarize = {
    name: "summarize",
    description: "Summarizes the caller's tasks.",
    inputSchema: z.object({ verbose: z.boolean().default(false) }),
    annotations: { readOnlyHint: true },
  };

  it("are listed after the generated tools and called with the session's principal, ctx.mcp and caller", async () => {
    const handler = vi.fn(async ({ arguments: args, principal, mcp, caller }) => {
      const tasks = await caller.taskService.list({});
      const who = await caller.taskService.whoami();
      return {
        args,
        principal,
        mcp,
        count: tasks.length,
        transport: who.transport,
        scopes: who.scopes,
      };
    });
    const { registry, records } = setup({ customTools: [{ ...summarize, handler }] });
    expect(registry.tools.map((tool) => tool.name).at(-1)).toBe("summarize");
    expect(registry.tools.at(-1)).toEqual({
      name: "summarize",
      description: "Summarizes the caller's tasks.",
      inputSchema: {
        $schema: "http://json-schema.org/draft-07/schema#",
        type: "object",
        properties: { verbose: { type: "boolean", default: false } },
      },
      annotations: { readOnlyHint: true },
    });
    expect(await registry.call("summarize", {}, { request: stdio() })).toEqual({
      ok: true,
      data: {
        args: { verbose: false },
        principal: TOKENS["writer-token"]?.principal,
        mcp: { scopes: ["tasks:read", "tasks:write"] },
        count: 2,
        transport: "mcp",
        scopes: ["tasks:read", "tasks:write"],
      },
    });
    expect(records.map((record) => [record.method, record.transport])).toEqual([
      ["list", "mcp"],
      ["whoami", "mcp"],
    ]);
  });

  it("validate their arguments with a Standard Schema, and fail with the code their handler throws", async () => {
    const handler = vi.fn(() => {
      throw new QuickdrawError("CONFLICT", "Already summarized");
    });
    const { registry } = setup({ customTools: [{ ...summarize, handler }] });
    const invalid = await registry.call("summarize", { verbose: "yes" }, { request: stdio() });
    expect(errorOf(invalid)).toMatchObject({
      code: "VALIDATION",
      message: 'Invalid input for the tool "summarize"',
      data: { issues: [{ path: ["verbose"], message: expect.any(String) }] },
    });
    expect(handler).not.toHaveBeenCalled();
    expect(errorOf(await registry.call("summarize", {}, { request: stdio() }))).toMatchObject({
      code: "CONFLICT",
      message: "Already summarized",
    });
  });

  it("take a JSON Schema as it is, and fail with a generic INTERNAL when the handler breaks", async () => {
    const { registry, logger } = setup({
      customTools: [
        {
          name: "echo",
          description: "Echoes its arguments.",
          inputSchema: { type: "object", properties: { text: { type: "string" } } },
          handler: ({ arguments: args }) => args,
        },
        {
          name: "broken",
          description: "Always breaks.",
          inputSchema: { type: "object" },
          handler: () => Promise.reject(new Error("disk full")),
        },
      ],
    });
    expect(await registry.call("echo", { text: "hi" }, { request: stdio() })).toEqual({
      ok: true,
      data: { text: "hi" },
    });
    expect(await registry.call("echo", undefined, { request: stdio() })).toEqual({
      ok: true,
      data: {},
    });
    expect(errorOf(await registry.call("broken", {}, { request: stdio() }))).toMatchObject({
      code: "INTERNAL",
      message: "Internal error",
    });
    expect(logger.at("error").map((entry) => entry.meta?.error)).toEqual([
      expect.objectContaining({ cause: expect.objectContaining({ message: "disk full" }) }),
    ]);
  });
});

describe("createMcpRegistry", () => {
  it("refuses a dispatcher that does not serve the services", () => {
    const { taskService, noteService } = createServices();
    const dispatcher = createDispatcher({ services: [taskService] });
    expect(() => createMcpRegistry({ services: [taskService, noteService], dispatcher })).toThrow(
      "createMcpRegistry: the dispatcher does not serve noteService; pass services the dispatcher was created with",
    );
    const other = createServices().taskService;
    expect(() => createMcpRegistry({ services: [other], dispatcher })).toThrow(
      "the dispatcher does not serve taskService",
    );
    expect(() =>
      createMcpRegistry({ services: [taskService], dispatcher: {} as typeof dispatcher }),
    ).toThrow(
      "createMcpRegistry: dispatcher must be a dispatcher from createDispatcher or qd.createServer",
    );
  });

  it("refuses custom tools that cannot be served, and names that clash", () => {
    const { taskService } = createServices();
    const dispatcher = createDispatcher({ services: [taskService] });
    const base = { services: [taskService] as const, dispatcher };
    const tool = {
      name: "echo",
      description: "Echoes.",
      inputSchema: { type: "object" as const },
      handler: () => null,
    };
    expect(() => createMcpRegistry({ ...base, customTools: [tool, tool] })).toThrow(
      'createMcpRegistry: two tools are named "echo": a custom tool and a custom tool',
    );
    expect(() =>
      createMcpRegistry({ ...base, customTools: [{ ...tool, name: "taskService_get" }] }),
    ).toThrow('two tools are named "taskService_get": taskService.get and a custom tool');
    expect(() =>
      createMcpRegistry({
        ...base,
        customTools: [
          { ...tool, inputSchema: { type: "string" } as unknown as typeof tool.inputSchema },
        ],
      }),
    ).toThrow(
      'custom tool "echo": inputSchema must be a Standard Schema, or a JSON Schema whose type is "object"',
    );
    expect(() =>
      createMcpRegistry({ ...base, customTools: [{ ...tool, description: "" }] }),
    ).toThrow('custom tool "echo" needs a description, a non-empty string');
    expect(() =>
      createMcpRegistry({ ...base, principal: "alice" as unknown as () => null }),
    ).toThrow("createMcpRegistry: principal must be a function of the MCP request");
  });

  it("fails at registration when a contract's input is a Zod 3 schema, saying to use Zod 4.2", () => {
    const legacy = defineContract("legacyService", {
      methods: { find: query({ input: z3.object({ id: z3.string() }), output: z3.string() }) },
    });
    const legacyService = qd.defineService(legacy, {
      methods: { find: { access: "public", handler: ({ input }) => input.id } },
    });
    const dispatcher = createDispatcher({ services: [legacyService] });
    expect(() => createMcpRegistry({ services: [legacyService], dispatcher })).toThrow(
      "createMcpRegistry: the input schema of legacyService.find cannot describe itself as JSON Schema, which an MCP tool needs: use Zod 4.2 or later for that schema, or leave legacyService.find out with exclude",
    );
    const custom = {
      name: "legacy",
      description: "A tool with a Zod 3 schema.",
      inputSchema: z3.object({ q: z3.string() }),
      handler: () => null,
    };
    expect(() =>
      createMcpRegistry({
        services: [legacyService],
        dispatcher,
        exclude: ["legacyService"],
        customTools: [custom],
      }),
    ).toThrow(
      'createMcpRegistry: the input schema of custom tool "legacy" cannot describe itself as JSON Schema, which an MCP tool needs: use Zod 4.2 or later for that schema, or give the tool a JSON Schema object instead',
    );
  });
});
