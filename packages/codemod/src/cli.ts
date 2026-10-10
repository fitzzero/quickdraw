// `quickdraw-codemod v5 <repo> [options]`: moves a quickdraw 4.x app to 5.0.

import { parseArgs } from "node:util";
import { runCodemod, type RunResult } from "./index";
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

function run(argv: readonly string[], output: Output): void {
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
        help: { type: "boolean", short: "h" },
      },
    });
  } catch (error) {
    fail(error instanceof Error ? error.message : String(error));
  }
  const { values, positionals } = parsed;
  if (values.help === true) {
    output.out(USAGE);
    return;
  }
  const [transform, root] = positionals;
  if (transform !== "v5" || root === undefined || positionals.length > 2) {
    fail(transform === "v5" ? "name the app's repository root" : "the only transform is v5");
  }
  const dryRun = values["dry-run"] === true;
  const result = runCodemod({
    root,
    dryRun,
    ...(values.shared === undefined ? {} : { shared: values.shared }),
    ...(values.api === undefined ? {} : { api: values.api }),
    ...(values.web === undefined ? {} : { web: values.web }),
    ...(values["db-package"] === undefined ? {} : { dbPackage: values["db-package"] }),
  });
  const { stats } = result;
  const lines = [
    `quickdraw-codemod v5${dryRun ? " (dry run: nothing written)" : ""}`,
    `  ${String(stats.services)} services, ${String(stats.methods)} methods, ${String(stats.contracts)} contracts (${String(stats.schemasMoved)} schemas moved, ${String(stats.todoSchemas)} todoSchema placeholders)`,
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
