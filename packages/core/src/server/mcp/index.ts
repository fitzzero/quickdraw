// MCP bridge exports for @fitzzero/quickdraw-core/server/mcp (RFC 0003
// section 10). Tools are generated at run time from the contracts the
// services were defined from, and every tool call goes through the
// dispatcher with transport "mcp". The bridge is its own export so that apps
// without agents never load it; `./server` holds no MCP code.

export { describeTools } from "./tools";
export { createMcpRegistry, type McpRegistry, type McpRegistryOptions } from "./registry";
export { toToolResult } from "./result";
export {
  createMcpStdioServer,
  MCP_PROTOCOL_VERSION,
  type McpStdioServer,
  type McpStdioServerOptions,
} from "./stdio";
export { bootstrapMcpServer } from "./bootstrap";
export { createMcpHttpRouter, type McpHttpReply, type McpHttpRouterOptions } from "./http";
export type {
  DescribeToolsOptions,
  McpCallOptions,
  McpCallResult,
  McpContextOfServices,
  McpCustomTool,
  McpHttpRequest,
  McpInputSchema,
  McpMethodRef,
  McpRequest,
  McpStdioRequest,
  McpTextContent,
  McpTool,
  McpToolAnnotations,
  McpToolCall,
  McpToolResult,
} from "./types";
