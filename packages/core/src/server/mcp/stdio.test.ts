// The MCP stdio server (RFC 0003 section 10): 4.1's JSON-RPC wire format over
// the registry, first in process over in-memory streams, then as a spawned
// process with piped stdin and stdout, started through bootstrapMcpServer.

import { spawn } from "node:child_process";
import { dirname, resolve } from "node:path";
import { createInterface } from "node:readline";
import { PassThrough } from "node:stream";
import { fileURLToPath } from "node:url";
import { describe, expect, it, vi } from "vitest";
import { tick } from "../__tests__/fixtures";
import { agentAuth, setup } from "./__tests__/fixtures";
import { createMcpStdioServer, MCP_PROTOCOL_VERSION } from "./index";

type Message = Record<string, unknown> & { readonly id?: unknown };

/**
 * A client's view of a stdio connection: send lines, read replies by id.
 * A reply is awaited for `timeoutMs`, `vi.waitFor`'s default of one second
 * unless given.
 */
function client(write: (line: string) => void, messages: Message[], timeoutMs?: number) {
  const send = (message: unknown): void => write(`${JSON.stringify(message)}\n`);
  const reply = (id: unknown): Promise<Message> =>
    vi.waitFor(
      () => {
        const found = messages.find((message) => message.id === id);
        if (found === undefined) {
          throw new Error(`no reply to ${JSON.stringify(id)} yet`);
        }
        return found;
      },
      timeoutMs === undefined ? undefined : { timeout: timeoutMs },
    );
  const request = (id: unknown, method: string, params?: unknown): Promise<Message> => {
    send(
      params === undefined
        ? { jsonrpc: "2.0", id, method }
        : { jsonrpc: "2.0", id, method, params },
    );
    return reply(id);
  };
  return { send, reply, request };
}

function textOf(message: Message): unknown {
  const result = message.result as { content: { type: string; text: string }[] };
  expect(result.content).toHaveLength(1);
  expect(result.content[0]?.type).toBe("text");
  return JSON.parse(result.content[0]?.text ?? "") as unknown;
}

/** A stdio server over in-memory streams. */
function open(options: Parameters<typeof setup>[0] = {}) {
  const { registry, services, logger } = setup(options);
  const input = new PassThrough();
  const output = new PassThrough();
  const server = createMcpStdioServer({
    registry,
    name: "quickdraw-test",
    version: "1.2.3",
    input,
    output,
    logger,
  });
  const messages: Message[] = [];
  createInterface({ input: output }).on("line", (line) =>
    messages.push(JSON.parse(line) as Message),
  );
  return {
    server,
    input,
    messages,
    services,
    logger,
    ...client((line) => input.write(line), messages),
  };
}

describe("the stdio server", () => {
  it("answers initialize, ping and tools/list as 4.1 did, and never replies to a notification", async () => {
    const { request, send, messages, server } = open();
    expect(
      await request(1, "initialize", {
        protocolVersion: "2025-06-18",
        capabilities: {},
        clientInfo: { name: "t", version: "1" },
      }),
    ).toEqual({
      jsonrpc: "2.0",
      id: 1,
      result: {
        protocolVersion: MCP_PROTOCOL_VERSION,
        serverInfo: { name: "quickdraw-test", version: "1.2.3" },
        capabilities: { tools: {} },
      },
    });
    send({ jsonrpc: "2.0", method: "notifications/initialized" });
    send({ jsonrpc: "2.0", method: "initialized" });
    send({ jsonrpc: "2.0", method: "notifications/roots/list_changed" });
    expect(await request("p", "ping")).toEqual({ jsonrpc: "2.0", id: "p", result: {} });
    const list = await request(2, "tools/list");
    const { tools } = list.result as { tools: { name: string; annotations?: unknown }[] };
    expect(tools.map((tool) => tool.name)).toEqual([
      "taskService_get",
      "taskService_list",
      "taskService_rename",
      "taskService_whoami",
      "noteService_search",
      "noteService_archive",
      "noteService_wait",
    ]);
    expect(tools[0]?.annotations).toEqual({ readOnlyHint: true });
    expect(MCP_PROTOCOL_VERSION).toBe("2024-11-05");
    await tick(10);
    expect(messages.map((message) => message.id)).toEqual([1, "p", 2]);
    expect(server.sessionId).toEqual(expect.any(String));
  });

  it("calls a tool: its value as JSON text, a failure as a tool error with the code", async () => {
    const { request } = open(agentAuth(() => "reader-token"));
    const ok = await request(3, "tools/call", { name: "taskService_get", arguments: { id: "t7" } });
    expect(ok.result).not.toHaveProperty("isError");
    expect(textOf(ok)).toEqual({ id: "t7", title: "Write the RFC", done: false });
    const forbidden = await request(4, "tools/call", {
      name: "taskService_rename",
      arguments: { id: "t7", title: "Ship it" },
    });
    expect(forbidden.result).toMatchObject({ isError: true });
    expect(textOf(forbidden)).toEqual({ code: "FORBIDDEN", message: "Insufficient permissions" });
    const invalid = await request(5, "tools/call", { name: "taskService_get" });
    expect(textOf(invalid)).toMatchObject({
      code: "VALIDATION",
      data: { issues: [{ path: ["id"] }] },
    });
  });

  it("answers protocol errors with JSON-RPC error codes, and ignores a client's response", async () => {
    const { request, send, reply, input, messages } = open();
    expect(await request(6, "resources/list")).toEqual({
      jsonrpc: "2.0",
      id: 6,
      error: { code: -32601, message: "Method not found: resources/list" },
    });
    expect((await request(7, "tools/call", { arguments: {} })).error).toEqual({
      code: -32602,
      message: "tools/call needs params { name, arguments? }",
    });
    expect((await request(8, "tools/call", { name: "nope" })).error).toEqual({
      code: -32602,
      message: "Unknown tool: nope",
    });
    send({ jsonrpc: "2.0", id: 9, result: {} });
    input.write("{not json\n");
    expect(await reply(null)).toEqual({
      jsonrpc: "2.0",
      id: null,
      error: { code: -32700, message: "Parse error" },
    });
    send([{ jsonrpc: "2.0", id: 10, method: "ping" }]);
    send({ jsonrpc: "2.0", id: null, method: "ping" });
    await vi.waitFor(() =>
      expect(messages.filter((message) => message.id === null)).toHaveLength(3),
    );
    expect(
      messages.filter((message) => message.id === null).map((message) => message.error),
    ).toEqual([
      { code: -32700, message: "Parse error" },
      { code: -32600, message: "Invalid Request" },
      { code: -32600, message: "Invalid Request" },
    ]);
    await tick(10);
    expect(messages.some((message) => message.id === 9 || message.id === 10)).toBe(false);
  });

  it("runs calls concurrently, and cancels one on notifications/cancelled without replying to it", async () => {
    const { request, send, messages, services } = open();
    send({
      jsonrpc: "2.0",
      id: 11,
      method: "tools/call",
      params: { name: "noteService_wait", arguments: { key: "slow" } },
    });
    await vi.waitFor(() => expect(services.signals.has("slow")).toBe(true));
    const search = await request(12, "tools/call", {
      name: "noteService_search",
      arguments: { input: "x" },
    });
    expect(textOf(search)).toEqual(["a note about x"]);
    expect(
      (await request(11, "tools/call", { name: "noteService_search", arguments: { input: "y" } }))
        .error,
    ).toEqual({
      code: -32600,
      message: "Request 11 is already in flight",
    });
    send({
      jsonrpc: "2.0",
      method: "notifications/cancelled",
      params: { requestId: 11, reason: "user" },
    });
    await vi.waitFor(() => expect(services.signals.get("slow")?.aborted).toBe(true));
    await tick(10);
    expect(messages.filter((message) => message.id === 11).map((message) => message.error)).toEqual(
      [{ code: -32600, message: "Request 11 is already in flight" }],
    );
  });

  it("ends when its input ends, cancelling the calls in flight", async () => {
    const { send, input, server, services, messages } = open();
    send({
      jsonrpc: "2.0",
      id: 13,
      method: "tools/call",
      params: { name: "noteService_wait", arguments: { key: "end" } },
    });
    await vi.waitFor(() => expect(services.signals.has("end")).toBe(true));
    input.end();
    await server.closed;
    expect(services.signals.get("end")?.aborted).toBe(true);
    expect(messages.some((message) => message.id === 13)).toBe(false);
    await expect(server.close()).resolves.toBeUndefined();
  });

  it("ends when its output fails, logging why", async () => {
    const { registry, logger } = setup();
    const output = new PassThrough();
    const server = createMcpStdioServer({
      registry,
      name: "t",
      version: "1",
      input: new PassThrough(),
      output,
      logger,
    });
    output.destroy(new Error("EPIPE"));
    await server.closed;
    expect(logger.at("warn").map((entry) => entry.message)).toEqual([
      "The MCP stdio stream failed; the session ends",
    ]);
  });

  it("refuses options without a registry, a name or a version", () => {
    const { registry } = setup();
    expect(() => createMcpStdioServer({ name: "t", version: "1" } as never)).toThrow(
      "createMcpStdioServer: registry must come from createMcpRegistry",
    );
    expect(() => createMcpStdioServer({ registry, name: "t" } as never)).toThrow(
      "createMcpStdioServer: name and version must be strings, for serverInfo",
    );
  });
});

const packageDir = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");
const CHILD = resolve(packageDir, "src/server/mcp/__tests__/stdioChild.ts");

/** What `stdioServer.ts` writes to stderr once its server reads stdin. */
const READY = "stdio harness: ready";

/**
 * How long the spawned process may take. Starting `node --import tsx` and
 * compiling the server module takes well over a second on a cold CI runner,
 * past `vi.waitFor`'s default.
 */
const SPAWN_TIMEOUT_MS = 15_000;

/** Spawns the harness's MCP entry with piped stdin, stdout and stderr. */
function spawnServer(token: string) {
  const child = spawn(process.execPath, ["--import", "tsx", CHILD], {
    cwd: packageDir,
    env: { ...process.env, QD_MCP_TOKEN: token },
    stdio: ["pipe", "pipe", "pipe"],
  });
  const messages: Message[] = [];
  const stdout: string[] = [];
  let stderr = "";
  createInterface({ input: child.stdout }).on("line", (line) => {
    stdout.push(line);
    messages.push(JSON.parse(line) as Message);
  });
  child.stderr.on("data", (chunk: Buffer) => {
    stderr += chunk.toString("utf8");
  });
  const exited = new Promise<number | null>((resolveExit) => {
    child.once("exit", (code) => resolveExit(code));
  });
  const ready = (): Promise<void> =>
    vi.waitFor(
      () => {
        if (!stderr.includes(READY)) {
          throw new Error(`the spawned server has not written "${READY}" yet:\n${stderr}`);
        }
      },
      { timeout: SPAWN_TIMEOUT_MS, interval: 20 },
    );
  return {
    child,
    stdout,
    stderr: () => stderr,
    exited,
    ready,
    ...client((line) => child.stdin.write(line), messages, SPAWN_TIMEOUT_MS),
  };
}

describe("a spawned stdio server", () => {
  it("lists its tools and calls one over real pipes, as the mapped principal over transport mcp", async () => {
    const server = spawnServer("reader-token");
    try {
      await server.ready();
      const init = await server.request(1, "initialize", {
        protocolVersion: "2024-11-05",
        capabilities: {},
        clientInfo: { name: "harness", version: "1" },
      });
      expect(init.result).toMatchObject({
        protocolVersion: "2024-11-05",
        serverInfo: { name: "quickdraw-harness", version: "0.0.0" },
      });
      server.send({ jsonrpc: "2.0", method: "notifications/initialized" });
      const list = await server.request(2, "tools/list");
      expect(
        (list.result as { tools: { name: string }[] }).tools.map((tool) => tool.name),
      ).toContain("taskService_whoami");
      const who = await server.request(3, "tools/call", {
        name: "taskService_whoami",
        arguments: {},
      });
      expect(textOf(who)).toEqual({
        userId: "alice",
        kind: "agent",
        transport: "mcp",
        scopes: ["tasks:read"],
      });
      const forbidden = await server.request(4, "tools/call", {
        name: "taskService_rename",
        arguments: { id: "t1", title: "Ship it" },
      });
      expect(forbidden.result).toMatchObject({ isError: true });
      expect(textOf(forbidden)).toMatchObject({ code: "FORBIDDEN" });
      server.child.stdin.end();
      expect(await server.exited).toBe(0);
      expect(server.stdout).toHaveLength(4);
      expect(server.stderr()).toContain(
        "stdio harness: console output while the server module loads",
      );
      expect(server.stderr()).toContain("taskService.whoami ok in");
      expect(server.stderr()).toContain("stdio harness: closed");
    } finally {
      server.child.kill();
    }
  }, 30_000);
});
