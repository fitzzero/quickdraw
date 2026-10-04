import { readFile, writeFile } from "node:fs/promises";
import { relative, resolve } from "node:path";
import { parseArgs } from "node:util";
import { compare } from "./compare";
import { renderComparison } from "./compare-report";
import { BENCH_DIR } from "./paths";
import { resultSchema, type BenchResult } from "./result-schema";

/**
 * Renders a matched comparison report from three result files of one
 * sitting (docs/benchmarks.md, "Comparing a new version"):
 *
 *   bun run --filter bench compare -- --before <old.json> --after <new.json> \
 *     --again <old-again.json> --out reports/<new>.md [--analysis <notes.md>]
 *
 * Paths are relative to bench/. It refuses results whose workload,
 * parameters, limits, machine or runtime versions differ.
 */

const USAGE =
  "usage: bun run --filter bench compare -- --before <old.json> --after <new.json> --again <old-again.json> --out <report.md> [--analysis <notes.md>]\n";

async function readResult(path: string): Promise<BenchResult> {
  return resultSchema.parse(JSON.parse(await readFile(path, "utf8")));
}

async function main(): Promise<number> {
  const { values } = parseArgs({
    args: process.argv.slice(2).filter((arg) => arg !== "--"),
    strict: true,
    options: {
      before: { type: "string" },
      after: { type: "string" },
      again: { type: "string" },
      out: { type: "string" },
      analysis: { type: "string" },
    },
  });
  const { before, after, again, out } = values;
  if (before === undefined || after === undefined || again === undefined || out === undefined) {
    process.stderr.write(USAGE);
    return 1;
  }
  const path = (file: string): string => resolve(BENCH_DIR, file);
  const comparison = compare(
    await readResult(path(before)),
    await readResult(path(after)),
    await readResult(path(again)),
  );
  const analysis =
    values.analysis === undefined ? null : await readFile(path(values.analysis), "utf8");
  const shown = (file: string): string => relative(BENCH_DIR, path(file));
  const markdown = renderComparison(
    comparison,
    { before: shown(before), after: shown(after), again: shown(again) },
    analysis,
  );
  await writeFile(path(out), markdown);
  process.stdout.write(`wrote ${path(out)}\n`);
  return 0;
}

process.exit(await main());
