import * as readline from "readline";
import type { McpStdioServerOptions } from "./types";

interface JsonRpcRequest {
  jsonrpc: "2.0";
  id: string | number;
  method: string;
  params?: Record<string, unknown>;
}

interface JsonRpcResponse {
  jsonrpc: "2.0";
  id: string | number | null;
  result?: unknown;
  error?: {
    code: number;
    message: string;
    data?: unknown;
  };
}

export function createMcpStdioServer(options: McpStdioServerOptions): void {
  const { name, version, registry, defaultUserId } = options;

  const serverInfo = { name, version };
  const capabilities = { tools: {} };

  function getToolDefinitions() {
    return registry.listTools({
      defaultUserId: defaultUserId ?? process.env.MCP_USER_ID,
    });
  }

  async function handleRequest(request: JsonRpcRequest): Promise<JsonRpcResponse | null> {
    const { id, method, params } = request;

    try {
      switch (method) {
        case "initialize":
          return {
            jsonrpc: "2.0",
            id,
            result: {
              protocolVersion: "2024-11-05",
              serverInfo,
              capabilities,
            },
          };

        case "initialized":
        case "notifications/initialized":
          return null;

        case "tools/list":
          return {
            jsonrpc: "2.0",
            id,
            result: { tools: getToolDefinitions() },
          };

        case "tools/call": {
          const { name: serviceName, arguments: args } = params as {
            name: string;
            arguments?: Record<string, unknown>;
          };

          const methodName = args?.method as string | undefined;
          if (!methodName) {
            return {
              jsonrpc: "2.0",
              id,
              error: {
                code: -32602,
                message: `Missing required argument "method" for service ${serviceName}`,
              },
            };
          }

          const userId =
            (args?.userId as string) ?? defaultUserId ?? process.env.MCP_USER_ID ?? "mcp-anonymous";
          const payload = args?.payload;

          const result = await registry.invoke(serviceName, methodName, payload, userId);

          return {
            jsonrpc: "2.0",
            id,
            result: {
              content: [
                {
                  type: "text",
                  text: JSON.stringify(result, null, 2),
                },
              ],
            },
          };
        }

        case "ping":
          return { jsonrpc: "2.0", id, result: {} };

        default:
          return {
            jsonrpc: "2.0",
            id,
            error: { code: -32601, message: `Method not found: ${method}` },
          };
      }
    } catch (error) {
      return {
        jsonrpc: "2.0",
        id,
        error: {
          code: -32000,
          message: error instanceof Error ? error.message : "Unknown error",
        },
      };
    }
  }

  async function main(): Promise<void> {
    const rl = readline.createInterface({
      input: process.stdin,
      output: process.stdout,
      terminal: false,
    });

    function send(response: JsonRpcResponse): void {
      process.stdout.write(JSON.stringify(response) + "\n");
    }

    for await (const line of rl) {
      if (!line.trim()) continue;

      try {
        const request = JSON.parse(line) as JsonRpcRequest;
        const response = await handleRequest(request);
        if (response !== null) {
          send(response);
        }
      } catch {
        send({
          jsonrpc: "2.0",
          id: null,
          error: { code: -32700, message: "Parse error" },
        });
      }
    }
  }

  main().catch((error: unknown) => {
    process.stderr.write(`Fatal error: ${error}\n`);
    process.exit(1);
  });
}
