// `quickdraw-protocol`: writes `docs/protocol-v5.md`, the wire specification
// for clients in any language, from the protocol's sources
// (`protocolSource.ts`), so it is never maintained by hand. With `--check` it
// writes nothing and exits 1 when the file differs from what the sources
// generate; CI runs that. A repository tool, run from `packages/core`:
//
//   bun run protocol:sync     # writes docs/protocol-v5.md
//   bun run protocol:check    # fails when it is stale
//
// Not a published bin: the document describes the framework's own wire, which
// only this repository changes, and reading the sources needs the TypeScript
// compiler, which the published package does not depend on.

import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { protocolModel } from "./protocolModel";
import { PROTOCOL_MARKER, renderProtocol } from "./protocolRender";
import { readSources } from "./protocolSource";

const USAGE = `Usage: quickdraw-protocol [--check]

  Writes docs/protocol-v5.md from packages/core/src/protocol/envelope.ts and the
  sources beside it.
  --check  write nothing; exit 1 when the document differs from the sources
`;

/** Where the generator reads and writes. */
export interface ProtocolPaths {
  /** The core package, whose `src/` holds the sources. */
  readonly packageDir: string;
  /** The document. */
  readonly out: string;
}

/** The core package this module belongs to, and `docs/protocol-v5.md` at the repository's root. */
export function defaultPaths(): ProtocolPaths {
  const packageDir = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
  return { packageDir, out: join(packageDir, "..", "..", "docs", "protocol-v5.md") };
}

/** The document the sources of the core package at `packageDir` generate. */
export function generateProtocol(packageDir: string): string {
  return renderProtocol(protocolModel(readSources(packageDir)));
}

/** Where `main` writes; the command passes the process's streams. */
export interface ProtocolOutput {
  out(text: string): void;
  err(text: string): void;
}

function readText(path: string): string | undefined {
  return existsSync(path) ? readFileSync(path, "utf8") : undefined;
}

/**
 * Runs the command with `args` and resolves with its exit code: 0, 1 when
 * `--check` finds the document stale or it cannot be written, 2 for a usage
 * error.
 */
export function main(
  args: readonly string[],
  io: ProtocolOutput,
  paths: ProtocolPaths = defaultPaths(),
): number {
  if (args.includes("--help") || args.includes("-h")) {
    io.out(USAGE);
    return 0;
  }
  const unknown = args.find((arg) => arg !== "--check");
  if (unknown !== undefined) {
    io.err(`quickdraw-protocol: unknown argument "${unknown}"\n\n${USAGE}`);
    return 2;
  }
  const shown = relative(process.cwd(), paths.out);
  try {
    const text = generateProtocol(paths.packageDir);
    const current = readText(paths.out);
    if (current !== undefined && !current.startsWith(PROTOCOL_MARKER)) {
      throw new Error(`${shown} was not written by quickdraw-protocol: move it first`);
    }
    if (current === text) {
      io.out(`quickdraw-protocol: ${shown} matches the sources\n`);
      return 0;
    }
    if (args.includes("--check")) {
      io.err(
        `quickdraw-protocol: ${shown} differs from the protocol sources: run bun run protocol:sync in packages/core\n`,
      );
      return 1;
    }
    writeFileSync(paths.out, text);
    io.out(`quickdraw-protocol: wrote ${shown}\n`);
    return 0;
  } catch (error) {
    io.err(`quickdraw-protocol: ${error instanceof Error ? error.message : String(error)}\n`);
    return 1;
  }
}
