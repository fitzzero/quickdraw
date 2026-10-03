// `quickdraw-lint baseline`: runs oxlint with the app's own config and
// records how many times each quickdraw rule reports in each file, in
// `.quickdraw-lint-baseline.json` (format in `../plugin/baseline.mjs`). Rules
// given that file through their `baseline` option, or all of them through
// `settings.quickdraw.baseline`, then report only what goes beyond the
// counts. Run it again after fixing old violations so the counts go down.
//
// oxlint runs with QUICKDRAW_LINT_BASELINE=ignore, so the baseline being
// replaced hides nothing from the new one.

import { spawnSync } from "node:child_process";
import fs from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { parseArgs } from "node:util";
import { BASELINE_ENV, BASELINE_FILE, BASELINE_VERSION } from "../plugin/baseline.mjs";

export const USAGE = `Usage: quickdraw-lint baseline [options] [paths...]

Runs oxlint over the paths (default: the current directory) and writes how
many times each quickdraw rule reports in each file. Rules given the file
(the "baseline" option, or settings.quickdraw.baseline) then report only new
violations.

Options:
  -c, --config <file>   oxlint config to use (default: oxlint's own lookup)
  -o, --output <file>   baseline file to write (default: ${BASELINE_FILE})
      --plugin <name>   the name the quickdraw plugin is loaded under (default: quickdraw)
  -h, --help            show this help
`;

/**
 * The oxlint script installed for `cwd`, found the way Node finds the
 * package (oxlint's export map does not expose its package.json).
 */
export function findOxlint(cwd) {
  const require = createRequire(path.join(cwd, "package.json"));
  for (const directory of require.resolve.paths("oxlint") ?? []) {
    const manifest = path.join(directory, "oxlint", "package.json");
    if (fs.existsSync(manifest)) {
      const { bin } = JSON.parse(fs.readFileSync(manifest, "utf8"));
      return path.join(path.dirname(manifest), typeof bin === "string" ? bin : bin.oxlint);
    }
  }
  throw new Error("oxlint is not installed here: add it as a dev dependency first");
}

/**
 * Runs oxlint over `paths` and returns its JSON report; every baseline is
 * ignored unless `ignoreBaselines` is false.
 */
export function runOxlint({
  cwd,
  config,
  paths,
  oxlint = findOxlint(cwd),
  ignoreBaselines = true,
}) {
  const args = [
    oxlint,
    "--format",
    "json",
    ...(config === undefined ? [] : ["--config", config]),
    ...paths,
  ];
  const env = { ...process.env };
  if (ignoreBaselines) {
    env[BASELINE_ENV] = "ignore";
  } else {
    delete env[BASELINE_ENV];
  }
  const result = spawnSync(process.execPath, args, {
    cwd,
    encoding: "utf8",
    maxBuffer: 1024 ** 3,
    env,
  });
  if (result.error !== undefined) {
    throw result.error;
  }
  try {
    return JSON.parse(result.stdout);
  } catch (error) {
    throw new Error(
      `oxlint did not produce a JSON report (exit code ${result.status}):\n${result.stderr || result.stdout}`,
      { cause: error },
    );
  }
}

function sortedObject(entries) {
  return Object.fromEntries([...entries].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)));
}

/**
 * Counts the `plugin` rules' diagnostics in an oxlint JSON report, per file
 * (relative to `directory`, with forward slashes) and rule.
 */
export function countViolations(report, { cwd, directory, plugin = "quickdraw" }) {
  const prefix = `${plugin}(`;
  const counts = new Map();
  for (const diagnostic of report.diagnostics ?? []) {
    const { code, filename } = diagnostic;
    if (typeof code !== "string" || !code.startsWith(prefix) || !code.endsWith(")")) {
      continue;
    }
    const rule = code.slice(prefix.length, -1);
    const file = path.relative(directory, path.resolve(cwd, filename)).split(path.sep).join("/");
    const rules = counts.get(file) ?? new Map();
    rules.set(rule, (rules.get(rule) ?? 0) + 1);
    counts.set(file, rules);
  }
  return sortedObject([...counts].map(([file, rules]) => [file, sortedObject(rules)]));
}

/**
 * Runs oxlint and writes the baseline file. Returns the file's path and how
 * many violations in how many files it records.
 */
export function writeBaseline({
  cwd = process.cwd(),
  config,
  output = BASELINE_FILE,
  paths = [],
  plugin,
  oxlint,
}) {
  const file = path.resolve(cwd, output);
  const report = runOxlint({ cwd, config, paths, oxlint });
  const files = countViolations(report, { cwd, directory: path.dirname(file), plugin });
  fs.writeFileSync(file, `${JSON.stringify({ version: BASELINE_VERSION, files }, null, 2)}\n`);
  const violations = Object.values(files)
    .flatMap((rules) => Object.values(rules))
    .reduce((sum, count) => sum + count, 0);
  return { file, violations, files: Object.keys(files).length };
}

/** The `baseline` command: returns the process exit code. */
export function main(
  args,
  { cwd = process.cwd(), stdout = process.stdout, stderr = process.stderr } = {},
) {
  let parsed;
  try {
    parsed = parseArgs({
      args,
      allowPositionals: true,
      options: {
        config: { type: "string", short: "c" },
        output: { type: "string", short: "o" },
        plugin: { type: "string" },
        help: { type: "boolean", short: "h" },
      },
    });
  } catch (error) {
    stderr.write(`quickdraw-lint baseline: ${error.message}\n\n${USAGE}`);
    return 2;
  }
  if (parsed.values.help === true) {
    stdout.write(USAGE);
    return 0;
  }
  try {
    const result = writeBaseline({
      cwd,
      config: parsed.values.config,
      output: parsed.values.output,
      paths: parsed.positionals,
      plugin: parsed.values.plugin,
    });
    stdout.write(
      `Wrote ${result.violations} violation(s) in ${result.files} file(s) to ${path.relative(cwd, result.file) || result.file}\n`,
    );
    return 0;
  } catch (error) {
    stderr.write(`quickdraw-lint baseline: ${error.message}\n`);
    return 1;
  }
}
