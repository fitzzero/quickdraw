// `bootstrapMcpServer`: loads the module that starts an MCP stdio server
// after sending console output to stderr, so nothing but the protocol
// reaches stdout, not even what that module's imports log while loading.
// Ported from 4.1 (`legacy-src/server/mcp/McpBootstrap.ts:12`) with two
// changes: a relative path is resolved against the working directory (4.1
// handed it to `import()`, which resolves it against the package's own file,
// so a relative path never found the app's module), and a module that fails
// to load sets the exit code instead of calling `process.exit`.

import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { writeStderr } from "./stderr";

function specifierOf(serverModule: string | URL): string {
  if (serverModule instanceof URL) {
    return serverModule.href;
  }
  return serverModule.startsWith("file:")
    ? serverModule
    : pathToFileURL(resolve(serverModule)).href;
}

/**
 * Sends `console.log`, `info`, `warn` and `debug` to stderr, sets
 * `MCP_MODE=true` (and `LOG_LEVEL=warn` unless it is set), then imports
 * `serverModule`, the module that creates the stdio server. A path is
 * resolved against the working directory; pass a URL to resolve it against
 * the calling module. Resolves once the module has loaded. When it fails to
 * load, the error goes to stderr and the process exit code becomes 1.
 *
 * @example
 * // mcp.ts: the MCP client runs `node dist/mcp.js`
 * import { bootstrapMcpServer } from "@fitzzero/quickdraw-core/server/mcp";
 * await bootstrapMcpServer(new URL("./mcp-server.js", import.meta.url));
 */
export async function bootstrapMcpServer(serverModule: string | URL): Promise<void> {
  process.env.MCP_MODE = "true";
  process.env.LOG_LEVEL ??= "warn";
  // The console methods that write to stdout; `console.error` writes to stderr already.
  Object.assign(console, {
    log: writeStderr,
    info: writeStderr,
    warn: writeStderr,
    debug: writeStderr,
  });
  try {
    await import(specifierOf(serverModule));
  } catch (error) {
    writeStderr("Bootstrap error:", error);
    process.exitCode = 1;
  }
}
