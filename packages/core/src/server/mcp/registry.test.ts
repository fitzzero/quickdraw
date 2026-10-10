// The MCP registry (RFC 0003 section 10): every method's tool call goes
// through the dispatcher with transport "mcp", so validation, access checks
// and the per-session concurrency cap apply as on a socket; the principal and
// `ctx.mcp` come from the registry's hooks; `bind` fills chosen arguments
// from the principal; custom tools sit beside the generated ones.

import { describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { z as z3 } from "zod3";
import { defineContract, query, QuickdrawError } from "../../index";
import { createDispatcher } from "../index";
import {
  agentAuth,
  bindSetup,
  createServices,
  qd,
  setup,
  TOKENS,
  type AgentMcp,
} from "./__tests__/fixtures";
import {
  createMcpRegistry,
  describeTools,
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

describe("bound arguments", () => {
  const DIALECT = "http://json-schema.org/draft-07/schema#";
  const inputSchemaOf = (
    registry: { tools: readonly { name: string; inputSchema: unknown }[] },
    name: string,
  ) => registry.tools.find((tool) => tool.name === name)?.inputSchema;

  it("are left out of the listed schema of each tool whose object input has them", () => {
    const { registry, served } = bindSetup();
    expect(inputSchemaOf(registry, "messageService_post")).toEqual({
      $schema: DIALECT,
      type: "object",
      properties: { message: { type: "string", minLength: 1 } },
      required: ["message"],
    });
    // the bound argument was the only required one, so nothing is required
    expect(inputSchemaOf(registry, "messageService_history")).toEqual({
      $schema: DIALECT,
      type: "object",
      properties: {
        limit: {
          type: "integer",
          exclusiveMinimum: 0,
          maximum: Number.MAX_SAFE_INTEGER,
          default: 20,
        },
      },
    });
    expect(inputSchemaOf(registry, "taskService_get")).toEqual({
      $schema: DIALECT,
      type: "object",
      properties: { id: { type: "string" } },
      required: ["id"],
    });
    // describeTools lists what the contracts declare: binding is the registry's
    expect(
      describeTools(served).find((tool) => tool.name === "messageService_post")?.inputSchema,
    ).toMatchObject({
      properties: { taskId: { type: "string" } },
      required: ["taskId", "message"],
    });
  });

  it("are filled from the principal before the input is validated", async () => {
    const seen: unknown[] = [];
    const { registry, records } = bindSetup({
      bind: {
        taskId: async (call) => {
          seen.push(call);
          return await Promise.resolve(call.principal.claims?.taskId);
        },
      },
    });
    expect(
      await registry.call("messageService_post", { message: "hi" }, { request: stdio() }),
    ).toEqual({
      ok: true,
      data: { taskId: "t1", message: "hi", by: "bob" },
    });
    expect(seen).toEqual([
      {
        principal: TOKENS["task-token"]?.principal,
        mcp: { scopes: ["tasks:read", "tasks:write"] },
        request: stdio(),
        service: "messageService",
        method: "post",
      },
    ]);
    // the agent may send its own task's id, as a prompt written for the full schema does
    expect(
      await registry.call(
        "messageService_post",
        { taskId: "t1", message: "again" },
        { request: stdio() },
      ),
    ).toMatchObject({ ok: true, data: { taskId: "t1", message: "again" } });
    const invalid = await registry.call(
      "messageService_post",
      { message: "" },
      { request: stdio() },
    );
    expect(errorOf(invalid)).toMatchObject({
      code: "VALIDATION",
      data: { issues: [{ path: ["message"] }] },
    });
    // a tool without the bound argument is called as it is
    expect(
      await registry.call("taskService_get", { id: "t9" }, { request: stdio() }),
    ).toMatchObject({
      ok: true,
      data: { id: "t9" },
    });
    expect(seen).toHaveLength(3);
    expect(records.map((record) => [record.method, record.outcome])).toEqual([
      ["post", "ok"],
      ["post", "ok"],
      ["post", "VALIDATION"],
      ["get", "ok"],
    ]);
  });

  it("refuse another value, a principal without the claim and an anonymous caller before the method runs", async () => {
    const { registry, records } = bindSetup();
    const other = await registry.call(
      "messageService_post",
      { taskId: "t2", message: "hi" },
      { request: stdio() },
    );
    expect(errorOf(other)).toMatchObject({
      code: "FORBIDDEN",
      message: '"taskId" is bound to the caller and cannot be set to another value',
    });
    expect(toToolResult(other).isError).toBe(true);
    const nonObject = await registry.call("messageService_post", ["t2"], { request: stdio() });
    expect(errorOf(nonObject)).toMatchObject({
      code: "VALIDATION",
      message: "Invalid input for messageService.post",
      data: { issues: [{ path: [], message: "Expected an object" }] },
    });

    const binder = vi.fn(() => undefined);
    const unbound = bindSetup({
      ...agentAuth(() => "writer-token"),
      bind: { taskId: binder },
    }).registry;
    expect(
      errorOf(await unbound.call("messageService_post", { message: "hi" }, { request: stdio() })),
    ).toMatchObject({
      code: "FORBIDDEN",
      message: '"taskId" is bound to the caller, who has none',
    });
    expect(binder).toHaveBeenCalledOnce();
    const empty = bindSetup({ bind: { taskId: () => null } }).registry;
    expect(errorOf(await empty.call("messageService_history", {}, { request: stdio() })).code).toBe(
      "FORBIDDEN",
    );

    const anonymous = bindSetup({
      principal: () => null,
      context: undefined,
      bind: { taskId: binder },
    }).registry;
    expect(
      errorOf(await anonymous.call("messageService_post", { message: "hi" }, { request: stdio() })),
    ).toMatchObject({
      code: "UNAUTHENTICATED",
      message: "Authentication required",
    });
    expect(binder).toHaveBeenCalledOnce();
    // an anonymous caller still calls the public methods that have nothing bound
    expect(
      await anonymous.call("noteService_search", { input: "rfc" }, { request: stdio() }),
    ).toMatchObject({
      ok: true,
    });
    expect(records).toEqual([]);
  });

  it("are filled in callMethod calls, the 4.1 route's shape, too", async () => {
    const { registry } = bindSetup();
    expect(
      await registry.callMethod("messageService", "post", { message: "hi" }, { request: stdio() }),
    ).toEqual({
      ok: true,
      data: { taskId: "t1", message: "hi", by: "bob" },
    });
    expect(
      await registry.callMethod("messageService", "history", undefined, { request: stdio() }),
    ).toEqual({
      ok: true,
      data: ["the last 20 messages of t1"],
    });
    const other = await registry.callMethod(
      "messageService",
      "post",
      { taskId: "t2", message: "hi" },
      { request: stdio() },
    );
    expect(errorOf(other).code).toBe("FORBIDDEN");
  });

  it("fail the call when a binder throws, with INTERNAL or a QuickdrawError's code, and hand every refusal to respond once", async () => {
    const { registry, logger } = bindSetup({
      bind: {
        taskId: () => {
          throw new Error("the claims store is down");
        },
      },
    });
    const respond = vi.fn(() => 0);
    const broken = await registry.call(
      "messageService_post",
      { message: "hi" },
      { request: stdio(), respond },
    );
    expect(errorOf(broken)).toMatchObject({ code: "INTERNAL", message: "Internal error" });
    expect(respond).toHaveBeenCalledExactlyOnceWith(broken);
    expect(logger.at("error").map((entry) => entry.message)).toEqual([
      'The MCP tool "messageService_post" failed',
    ]);

    const revoked = bindSetup({
      bind: {
        taskId: () =>
          Promise.reject(new QuickdrawError("UNAUTHENTICATED", "The task token was revoked")),
      },
    }).registry;
    respond.mockClear();
    const refused = await revoked.call(
      "messageService_post",
      { message: "hi" },
      { request: stdio(), respond },
    );
    expect(errorOf(refused)).toMatchObject({
      code: "UNAUTHENTICATED",
      message: "The task token was revoked",
    });
    expect(respond).toHaveBeenCalledExactlyOnceWith(refused);
    respond.mockClear();
    const other = await bindSetup().registry.callMethod(
      "messageService",
      "post",
      { taskId: "t2", message: "hi" },
      { request: stdio(), respond },
    );
    expect(errorOf(other).code).toBe("FORBIDDEN");
    expect(respond).toHaveBeenCalledExactlyOnceWith(other);
  });

  it("serve a method under a public name: name maps messageService.post to post_to_chat", async () => {
    const { registry } = bindSetup({
      include: ["messageService.post"],
      name: (service, method) =>
        service === "messageService" && method === "post" ? "post_to_chat" : method,
    });
    expect(registry.tools).toEqual([
      {
        name: "post_to_chat",
        description: "Posts a message to a task's chat.",
        inputSchema: {
          $schema: DIALECT,
          type: "object",
          properties: { message: { type: "string", minLength: 1 } },
          required: ["message"],
        },
      },
    ]);
    expect(await registry.call("post_to_chat", { message: "hi" }, { request: stdio() })).toEqual({
      ok: true,
      data: { taskId: "t1", message: "hi", by: "bob" },
    });
    expect(
      errorOf(
        await registry.call("post_to_chat", { taskId: "t2", message: "hi" }, { request: stdio() }),
      ).code,
    ).toBe("FORBIDDEN");
  });

  it("leave custom tools alone: they are never bound", async () => {
    const handler = vi.fn(({ arguments: args }: { readonly arguments: unknown }) => args);
    const { registry } = bindSetup({
      customTools: [
        {
          name: "route_to_child",
          description: "Posts to a child task.",
          inputSchema: z.object({ taskId: z.string(), message: z.string() }),
          handler,
        },
      ],
    });
    expect(inputSchemaOf(registry, "route_to_child")).toMatchObject({
      required: ["taskId", "message"],
    });
    expect(
      await registry.call("route_to_child", { taskId: "t2", message: "hi" }, { request: stdio() }),
    ).toEqual({
      ok: true,
      data: { taskId: "t2", message: "hi" },
    });
  });

  it("are checked when the registry is built", () => {
    const { served, dispatcher } = bindSetup();
    type Excluded = "noteService.archive" | "messageService";
    const build =
      (bind: unknown, exclude: readonly Excluded[] = []) =>
      () =>
        createMcpRegistry({
          services: served,
          dispatcher,
          bind: bind as Record<string, () => string>,
          exclude,
        });
    expect(build("taskId")).toThrow(
      "createMcpRegistry: bind must be an object of functions, one per argument it fills",
    );
    expect(build([() => "t1"])).toThrow("bind must be an object of functions");
    expect(build({ taskId: "t1" })).toThrow(
      "createMcpRegistry: bind.taskId must be a function of the call, returning the argument's value",
    );
    // a misspelled argument would leave the real one for the agent to fill
    expect(build({ tsakId: () => "t1" })).toThrow(
      'createMcpRegistry: bind.tsakId fills nothing: no method served as a tool has "tsakId" in its object input',
    );
    expect(build({ taskId: () => "t1" }, ["messageService"])).toThrow(
      'bind.taskId fills nothing: no method served as a tool has "taskId" in its object input',
    );
    // noteService.archive's input is a union: { by: "id", id } or { by: "tag", tag }
    expect(build({ tag: () => "x" })).toThrow(
      "createMcpRegistry: bind.tag names a property of the input of noteService.archive, which is not an object: bind fills properties of object inputs only; leave noteService.archive out with exclude, or make its input an object",
    );
    expect(build({ id: () => "t1" })).toThrow(
      "bind.id names a property of the input of noteService.archive, which is not an object",
    );
    const registry = build({ id: () => "t1" }, ["noteService.archive"])();
    expect(inputSchemaOf(registry, "taskService_rename")).toMatchObject({
      properties: { title: { type: "string" } },
      required: ["title"],
    });
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

  it("refuse an anonymous caller before anything runs, unless their access is public", async () => {
    const parse = vi.fn(() => true);
    const closed = vi.fn(() => "ran");
    const open = vi.fn(({ principal }: { readonly principal: unknown }) => ({ principal }));
    const customTools = [
      {
        name: "closed",
        description: "Needs a principal, by default.",
        inputSchema: z.object({}).refine(parse),
        handler: closed,
      },
      {
        name: "explicit",
        description: "Needs a principal, said outright.",
        inputSchema: { type: "object" as const },
        access: "authenticated" as const,
        handler: closed,
      },
      {
        name: "open",
        description: "Anyone may call it.",
        inputSchema: { type: "object" as const },
        access: "public" as const,
        handler: open,
      },
    ];
    const anonymous = setup({ principal: () => null, context: undefined, customTools }).registry;
    for (const name of ["closed", "explicit"]) {
      expect(errorOf(await anonymous.call(name, {}, { request: stdio() }))).toMatchObject({
        code: "UNAUTHENTICATED",
        message: "Authentication required",
      });
    }
    expect(parse).not.toHaveBeenCalled();
    expect(closed).not.toHaveBeenCalled();
    expect(await anonymous.call("open", {}, { request: stdio() })).toEqual({
      ok: true,
      data: { principal: null },
    });

    const agent = setup({ customTools }).registry;
    for (const name of ["closed", "explicit"]) {
      expect(await agent.call(name, {}, { request: stdio() })).toEqual({ ok: true, data: "ran" });
    }
    expect(await agent.call("open", {}, { request: stdio() })).toEqual({
      ok: true,
      data: { principal: TOKENS["writer-token"]?.principal },
    });
    expect(closed).toHaveBeenCalledTimes(2);
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
      createMcpRegistry({
        ...base,
        customTools: [{ ...tool, access: "admin" as unknown as "public" }],
      }),
    ).toThrow('custom tool "echo": access must be "public" or "authenticated"');
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
