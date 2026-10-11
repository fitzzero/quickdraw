// `quickdraw-codemod v5 <repo> [options]`: moves a quickdraw 4.x app to 5.0.

import { spawnSync } from "node:child_process";
import { constants, totalmem } from "node:os";
import { getHeapStatistics } from "node:v8";
import { parseArgs } from "node:util";
import {
  exitCode,
  exitNote,
  heapToUse,
  LARGE_APP,
  MAX_HEAP,
  namesHeap,
  RELAUNCHED_ENV,
} from "./heap";
import { runCodemod, type RunResult } from "./index";
import { findLayout, type LayoutOptions } from "./layout";
import { countSourceFiles } from "./project";
import { REPORT_FILE } from "./report";

const USAGE = `Usage: quickdraw-codemod v5 <repo> [options]

Moves a quickdraw 4.x app to 5.0: contracts in the shared package, services
as qd.defineService, the web app's hooks on the typed client. Formats what it
writes with the app's formatter (oxfmt, prettier or Biome, when installed),
then writes ${REPORT_FILE} at <repo> with every item left to decide.
Run it on a clean working tree.

Options:
  --dry-run             change nothing; print what would change
  --shared <dir>        the shared package (default packages/shared)
  --api <dir>           the api app (default apps/api)
  --web <dir>           the web app (default apps/web)
  --db-package <name>   the package prisma is imported from (default: packages/db's name)
  --heap <MiB>          the heap to run with (default: on an app of more than
                        ${LARGE_APP.toLocaleString("en")} files, 75% of the memory, at most ${String(MAX_HEAP)} MiB)
  -h, --help            show this help
`;

/** Where the command writes, so tests can read it. */
export interface Output {
  out(text: string): void;
  err(text: string): void;
}

class UsageError extends Error {}

function fail(message: string): never {
  throw new UsageError(message);
}

/** What the run's formatting did, as lines of the summary. */
function formatterLines({ formatter }: RunResult): string[] {
  if (formatter === undefined) {
    return [];
  }
  if (formatter.ok) {
    return [`  formatted with ${formatter.name}`];
  }
  const files = formatter.unformatted ?? [];
  const said = (formatter.output ?? "").split("\n").filter((line) => line.trim() !== "");
  return [
    `  ${formatter.name} failed on the files written (exit code ${String(formatter.status ?? 1)}): format them with the app's format script, then run the codemod again (it refreshes the report's lines)`,
    ...said.slice(0, 20).map((line) => `    ${line}`),
    ...(said.length > 20 ? [`    ... ${String(said.length - 20)} more lines`] : []),
    `  ${String(files.length)} files left unformatted:`,
    ...files.slice(0, 20).map((file) => `    ${file}`),
    ...(files.length > 20 ? [`    ... ${String(files.length - 20)} more`] : []),
  ];
}

/** The command's arguments: `help`, or the app's root, its layout options and the run's options. */
type Command =
  | { readonly help: true }
  | {
      readonly help: false;
      readonly root: string;
      readonly layout: LayoutOptions;
      readonly dryRun: boolean;
      readonly heap: number | undefined;
    };

function parse(argv: readonly string[]): Command {
  let parsed;
  try {
    parsed = parseArgs({
      args: [...argv],
      allowPositionals: true,
      options: {
        "dry-run": { type: "boolean" },
        shared: { type: "string" },
        api: { type: "string" },
        web: { type: "string" },
        "db-package": { type: "string" },
        heap: { type: "string" },
        help: { type: "boolean", short: "h" },
      },
    });
  } catch (error) {
    fail(error instanceof Error ? error.message : String(error));
  }
  const { values, positionals } = parsed;
  if (values.help === true) {
    return { help: true };
  }
  const [transform, root] = positionals;
  if (transform !== "v5" || root === undefined || positionals.length > 2) {
    fail(transform === "v5" ? "name the app's repository root" : "the only transform is v5");
  }
  const heap = values.heap === undefined ? undefined : Number(values.heap);
  if (heap !== undefined && (!Number.isInteger(heap) || heap < 256)) {
    fail("--heap takes a whole number of MiB, 256 or more");
  }
  return {
    help: false,
    root,
    layout: {
      ...(values.shared === undefined ? {} : { shared: values.shared }),
      ...(values.api === undefined ? {} : { api: values.api }),
      ...(values.web === undefined ? {} : { web: values.web }),
      ...(values["db-package"] === undefined ? {} : { dbPackage: values["db-package"] }),
    },
    dryRun: values["dry-run"] === true,
    heap,
  };
}

function run(argv: readonly string[], output: Output): void {
  const command = parse(argv);
  if (command.help) {
    output.out(USAGE);
    return;
  }
  const { dryRun } = command;
  const result = runCodemod({ root: command.root, dryRun, ...command.layout });
  const { stats } = result;
  const lines = [
    `quickdraw-codemod v5${dryRun ? " (dry run: nothing written)" : ""}`,
    `  ${String(stats.services)} services, ${String(stats.methods)} methods (${String(stats.aggregatorsRemoved)} aggregator functions removed), ${String(stats.contracts)} contracts (${String(stats.schemasMoved)} schemas moved, ${String(stats.todoSchemas)} todoSchema placeholders)`,
    `  ${String(stats.clientCalls)} web files rewritten, ${String(stats.wrappersDeleted)} wrapper hooks deleted`,
    `  ${dryRun ? "would change" : "changed"} ${String(result.changed.length)} files, ${dryRun ? "create" : "created"} ${String(result.created.length)}, ${dryRun ? "delete" : "deleted"} ${String(result.deleted.length)}`,
    `  ${String(result.items)} items to review${dryRun ? "" : `: see ${REPORT_FILE}`}`,
  ];
  lines.push(...formatterLines(result));
  if (dryRun) {
    lines.push(
      ...result.changed.map((file) => `  M ${file}`),
      ...result.created.map((file) => `  A ${file}`),
      ...result.deleted.map((file) => `  D ${file}`),
    );
  }
  output.out(`${lines.join("\n")}\n`);
  warn(output, result.warnings);
}

function warn(output: Output, warnings: readonly string[]): void {
  for (const warning of warnings) {
    output.err(`quickdraw-codemod: ${warning}\n`);
  }
}

/** Runs the command; returns its exit code (0, 1 on failure, 2 on a usage error). */
export function main(
  argv: readonly string[],
  output: Output = {
    out: (text) => process.stdout.write(text),
    err: (text) => process.stderr.write(text),
  },
): number {
  try {
    run(argv, output);
    return 0;
  } catch (error) {
    if (error instanceof UsageError) {
      output.err(`quickdraw-codemod: ${error.message}\n\n${USAGE}`);
      return 2;
    }
    output.err(`${error instanceof Error ? error.message : String(error)}\n`);
    return 1;
  }
}

/** The heap (MiB) to start the command again with, and the app's source files; `undefined` runs it here. */
export function relaunchHeap(argv: readonly string[]): { heap: number; files: number } | undefined {
  let command: Command;
  let files: number;
  try {
    command = parse(argv);
    if (command.help) {
      return undefined;
    }
    files = countSourceFiles(findLayout(command.root, command.layout));
  } catch {
    // main reports the usage error, or the layout it cannot find
    return undefined;
  }
  const heap = heapToUse({
    files,
    limit: Math.floor(getHeapStatistics().heap_size_limit / (1024 * 1024)),
    constrained: process.constrainedMemory(),
    total: totalmem(),
    requested: command.heap,
    explicit: namesHeap([...process.execArgv, ...(process.env.NODE_OPTIONS ?? "").split(/\s+/u)]),
    bun: process.versions.bun !== undefined,
    relaunched: process.env[RELAUNCHED_ENV] !== undefined,
  });
  return heap === undefined ? undefined : { heap, files };
}

/**
 * Runs the command from `bin`: here, or, on a large app or with `--heap`, in
 * a Node started again with that heap (see heap.ts). Returns its exit code.
 */
export function start(argv: readonly string[], bin: string): number {
  const relaunch = relaunchHeap(argv);
  if (relaunch === undefined) {
    return main(argv);
  }
  const { heap, files } = relaunch;
  process.stderr.write(
    `quickdraw-codemod: ${String(files)} source files: running with a ${String(heap)} MiB heap (--heap to change)\n`,
  );
  const child = spawnSync(
    process.execPath,
    [...process.execArgv, `--max-old-space-size=${String(heap)}`, bin, ...argv],
    { stdio: "inherit", env: { ...process.env, [RELAUNCHED_ENV]: "1" } },
  );
  if (child.error !== undefined) {
    process.stderr.write(
      `quickdraw-codemod: could not start node again (${child.error.message}): running with this heap\n`,
    );
    return main(argv);
  }
  const note = exitNote(heap, child.status, child.signal);
  if (note !== undefined) {
    process.stderr.write(`${note}\n`);
  }
  return exitCode(
    child.status,
    child.signal === null ? undefined : constants.signals[child.signal],
  );
}
