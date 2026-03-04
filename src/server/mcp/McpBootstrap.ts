/**
 * Bootstrap helper for MCP servers.
 * Redirects all console output to stderr before importing the actual server,
 * preventing log output from corrupting the JSON-RPC protocol on stdout.
 *
 * Usage in app's mcp-bootstrap.ts:
 * ```typescript
 * import { bootstrapMcpServer } from "@fitzzero/quickdraw-core/server";
 * bootstrapMcpServer("./mcp-server.js");
 * ```
 */
export function bootstrapMcpServer(serverModulePath: string): void {
  process.env.MCP_MODE = "true";
  process.env.LOG_LEVEL = process.env.LOG_LEVEL ?? "warn";

  const stderrWrite = (data: string): void => {
    process.stderr.write(data + "\n");
  };

  /* eslint-disable no-console */
  console.log = (...args: unknown[]): void => {
    stderrWrite(args.map(String).join(" "));
  };
  console.info = (...args: unknown[]): void => {
    stderrWrite(args.map(String).join(" "));
  };
  console.warn = (...args: unknown[]): void => {
    stderrWrite(args.map(String).join(" "));
  };
  console.debug = (...args: unknown[]): void => {
    stderrWrite(args.map(String).join(" "));
  };
  /* eslint-enable no-console */

  import(serverModulePath).catch((error: unknown) => {
    process.stderr.write(`Bootstrap error: ${error}\n`);
    process.exit(1);
  });
}
