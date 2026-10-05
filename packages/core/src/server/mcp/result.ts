// A tool call's result in the shape of MCP's `tools/call` result, as 4.1
// wrote it (4.1 `src/server/mcp/McpStdioServer.ts:85-96`): one text block
// holding the value as indented JSON. A failure is a tool error (`isError`)
// whose text is the error's wire form, `{ code, message, data? }`, so the
// agent sees the code; 4.1 answered a failed call with a JSON-RPC error
// instead. An `INTERNAL` failure keeps its generic message (`toWire`).

import { toWire } from "../../protocol/errors";
import type { McpCallResult, McpTextContent, McpToolResult } from "./types";

function jsonText(value: unknown): McpTextContent {
  // `JSON.stringify` returns `undefined` for `undefined` (a method that
  // returns nothing) and for a function.
  const text: string | undefined = JSON.stringify(value, null, 2);
  return { type: "text", text: text ?? "null" };
}

/**
 * The `tools/call` result of a tool call. Throws when the value cannot be
 * written as JSON (a `BigInt` or a cycle); a transport answers that with an
 * `INTERNAL` tool error.
 *
 * @example
 * toToolResult(await registry.call(name, args, { request }));
 */
export function toToolResult(result: McpCallResult): McpToolResult {
  if (!result.ok) {
    return { content: [jsonText(toWire(result.error))], isError: true };
  }
  return { content: [jsonText(result.data)] };
}
