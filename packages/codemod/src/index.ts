// One run of the 4.x to 5.0 codemod over an app laid out like the quickdraw
// template (see migrate.ts for the order of the transforms), then the app's
// own formatter over the files it wrote (format.ts), then the report, read
// back from the markers the formatted files hold.

import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { createContext, type Stats } from "./context";
import { findFormatter, FORMATTED } from "./format";
import { findLayout, type LayoutOptions, repoPath } from "./layout";
import { migrate } from "./migrate";
import { loadProject } from "./project";
import { buildReport, REPORT_FILE } from "./report";

/** Options of one run. */
export interface RunOptions extends LayoutOptions {
  /** The app's repository root. */
  readonly root: string;
  /** Change nothing on disk; report what would change. */
  readonly dryRun?: boolean;
}

/** What a run did (or, in a dry run, would do). */
export interface RunResult {
  readonly stats: Stats;
  /** Files changed, created and deleted, relative to the root. */
  readonly changed: readonly string[];
  readonly created: readonly string[];
  readonly deleted: readonly string[];
  readonly report: string;
  readonly items: number;
  /** The app's formatter the run formatted its files with, and whether that worked. */
  readonly formatter?: { readonly name: string; readonly ok: boolean };
}

/** Runs the codemod on the app at `options.root`. */
export function runCodemod(options: RunOptions): RunResult {
  const layout = findLayout(options.root, options);
  const project = loadProject(layout);
  const ctx = createContext(project, layout);
  migrate(ctx);
  const relative = (path: string): string => repoPath(layout, path);
  const written = project
    .getSourceFiles()
    .filter((file) => !file.isSaved())
    .map((file) => file.getFilePath());
  const changed = written.filter((path) => !ctx.created.has(path)).map(relative);
  const reportPath = join(layout.root, REPORT_FILE);
  const before = existsSync(reportPath) ? readFileSync(reportPath, "utf8") : undefined;
  const formatter = options.dryRun === true ? undefined : findFormatter(layout.root);
  let formatted = true;
  if (options.dryRun !== true) {
    project.saveSync();
    if (formatter !== undefined) {
      const files = written.filter((path) => FORMATTED.test(path));
      formatted = formatter.format(files);
      for (const path of files) {
        project.getSourceFile(path)?.refreshFromFileSystemSync();
      }
    }
  }
  const report = buildReport(ctx);
  let text = report.text;
  if (options.dryRun !== true && before !== text) {
    writeFileSync(reportPath, text);
    if (formatter?.markdown === true) {
      formatted = formatter.format([reportPath]) && formatted;
      text = readFileSync(reportPath, "utf8");
    }
  }
  const reportChanged = before !== text;
  const created = [...ctx.created].map(relative);
  return {
    stats: ctx.stats,
    // The report is created by the first run, and changed by a later one that finds other markers.
    changed: before !== undefined && reportChanged ? [...changed, REPORT_FILE] : changed,
    created: before === undefined ? [...created, REPORT_FILE] : created,
    deleted: [...ctx.deleted].map(relative),
    report: text,
    items: report.count,
    ...(formatter === undefined ? {} : { formatter: { name: formatter.name, ok: formatted } }),
  };
}
