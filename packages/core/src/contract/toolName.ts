// A method tool's default name. It lives with the contracts, not in the MCP
// bridge, so `quickdraw-docs` prints it without the bridge's entry: the
// bridge's own files ship in `./server/mcp` alone (scripts/dist-smoke.mjs).

/**
 * The name the MCP bridge gives a method's tool when the registry has no
 * `name` option: `{service}_{method}` (RFC 0003 section 10).
 */
export function defaultToolName(service: string, method: string): string {
  return `${service}_${method}`;
}
