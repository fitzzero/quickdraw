// The temporary apps the oxlint CLI tests lint (oxlint.test.mjs, check.test.mjs):
// an app laid out like the quickdraw template, extending the shipped configs,
// with oxlint linked in, and the helpers that write its files, lint it and
// write its baseline.

import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { findOxlint, runOxlint } from "../../bin/baseline.mjs";

export const LINT = fileURLToPath(new URL("../..", import.meta.url));
export const CORE = path.join(LINT, "..", "core");
export const REPO = path.join(LINT, "..", "..");
export const OXLINT = findOxlint(LINT);
export const BIN = path.join(LINT, "bin", "quickdraw-lint.mjs");

/** The temporary apps the tests created; `removeApps` deletes them. */
export const roots = [];

export function removeApps() {
  for (const root of roots.splice(0)) {
    fs.rmSync(root, { recursive: true, force: true });
  }
}

export function writeFiles(root, files) {
  for (const [file, code] of files) {
    fs.mkdirSync(path.dirname(path.join(root, file)), { recursive: true });
    fs.writeFileSync(path.join(root, file), code);
  }
}

/**
 * A temporary app extending the shipped configs (the base, then the template
 * unless `template` is false; the template alone when `template` is
 * "alone"), with `settings` and `overrides` of its own and oxlint installed
 * (linked to this package's).
 */
export function createApp(settings, { template = true, overrides } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "quickdraw-lint-app-"));
  fs.mkdirSync(path.join(root, "node_modules"));
  fs.symlinkSync(
    path.dirname(path.dirname(OXLINT)),
    path.join(root, "node_modules", "oxlint"),
    "dir",
  );
  const config = {
    extends: [
      ...(template === "alone" ? [] : [path.relative(root, path.join(LINT, "oxlint.base.jsonc"))]),
      ...(template ? [path.relative(root, path.join(LINT, "oxlint.template.jsonc"))] : []),
    ],
    plugins: ["typescript", "import", "react", "nextjs", "jsx_a11y"],
    ignorePatterns: ["**/node_modules/**"],
    ...(settings === undefined ? {} : { settings }),
    ...(overrides === undefined ? {} : { overrides }),
  };
  fs.writeFileSync(path.join(root, ".oxlintrc.json"), JSON.stringify(config));
  return root;
}

/**
 * The quickdraw diagnostics oxlint reports in `root`, as `{ rule, file, line, severity }`,
 * run from `root` or from `cwd` (a directory of the app) with the app's config.
 */
export function lint(root, cwd = root) {
  const report = runOxlint({
    cwd,
    config: path.relative(cwd, path.join(root, ".oxlintrc.json")) || undefined,
    paths: ["."],
    oxlint: OXLINT,
    ignoreBaselines: false,
  });
  // A rule that throws ("Error running JS plugin.") is a diagnostic without a code.
  const failure = report.diagnostics.find((diagnostic) => typeof diagnostic.code !== "string");
  if (failure !== undefined) {
    throw new Error(failure.message);
  }
  return report.diagnostics
    .filter((diagnostic) => diagnostic.code.startsWith("quickdraw("))
    .map((diagnostic) => ({
      rule: diagnostic.code.slice("quickdraw(".length, -1),
      file: diagnostic.filename.split(path.sep).join("/"),
      line: diagnostic.labels[0]?.span.line,
      severity: diagnostic.severity,
    }))
    .toSorted((a, b) => a.file.localeCompare(b.file) || a.line - b.line);
}

/** Every diagnostic oxlint reports for `paths`, run from `cwd` with the app's config, as `code file:line`. */
export function lintAll(root, cwd, paths = ["."]) {
  const report = runOxlint({
    cwd,
    config: path.relative(cwd, path.join(root, ".oxlintrc.json")),
    paths,
    oxlint: OXLINT,
    ignoreBaselines: false,
  });
  return report.diagnostics.map(
    (diagnostic) =>
      `${String(diagnostic.code)} ${path.relative(root, path.resolve(cwd, diagnostic.filename)).split(path.sep).join("/")}:${String(diagnostic.labels[0]?.span.line)}`,
  );
}

// The baseline tests' app: every quickdraw rule reads `.quickdraw-lint-baseline.json`.
export const BASELINE_SETTINGS = { quickdraw: { baseline: ".quickdraw-lint-baseline.json" } };
export const service = "apps/api/src/services/task.ts";
export const read = (model) => `export const read${model} = ({ db }) => db.${model}.findMany();\n`;
export const at = (rule, line, severity = "error", file = service) => ({
  rule,
  file,
  line,
  severity,
});
export const baseline = (root) => {
  const output = execFileSync(process.execPath, [BIN, "baseline"], {
    cwd: root,
    encoding: "utf8",
  });
  return {
    output,
    file: JSON.parse(fs.readFileSync(path.join(root, ".quickdraw-lint-baseline.json"), "utf8")),
  };
};
export const app = () => {
  const root = createApp(BASELINE_SETTINGS);
  roots.push(root);
  return root;
};
