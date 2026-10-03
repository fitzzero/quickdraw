// Writing to stderr. An MCP stdio server owns stdout for the protocol, so its
// own log lines, and everything `bootstrapMcpServer` takes from the console,
// go to stderr instead.

import { format, inspect } from "node:util";
import type { Logger } from "../../contract/logger";

/** Writes one line to stderr, formatting the arguments as `console.log` would. */
export function writeStderr(...args: unknown[]): void {
  process.stderr.write(`${format(...args)}\n`);
}

function entry(level: string): (message: string, meta?: Record<string, unknown>) => void {
  return (message, meta) => {
    const details = meta === undefined ? "" : ` ${inspect(meta, { breakLength: Infinity })}`;
    process.stderr.write(`[${level}] ${message}${details}\n`);
  };
}

/** A logger that writes each entry to stderr as one line. */
export const stderrLogger: Logger = {
  debug: entry("DEBUG"),
  info: entry("INFO"),
  warn: entry("WARN"),
  error: entry("ERROR"),
  child: () => stderrLogger,
};
