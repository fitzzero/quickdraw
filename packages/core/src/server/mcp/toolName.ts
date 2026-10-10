// A method tool's default name, on its own so `quickdraw-docs` can print it
// without loading the bridge.

/**
 * The name the MCP bridge gives a method's tool when the registry has no
 * `name` option: `{service}_{method}` (RFC 0003 section 10).
 */
export function defaultToolName(service: string, method: string): string {
  return `${service}_${method}`;
}
