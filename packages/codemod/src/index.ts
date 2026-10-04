// One run of the 4.x to 5.0 codemod over an app laid out like the quickdraw
// template (see migrate.ts for the order of the transforms), then the report,
// read back from the markers the run left.

import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { createContext, type Stats } from "./context";
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
}

/** Runs the codemod on the app at `options.root`. */
export function runCodemod(options: RunOptions): RunResult {
  const layout = findLayout(options.root, options);
  const project = loadProject(layout);
  const ctx = createContext(project, layout);
  migrate(ctx);
  const report = buildReport(ctx);
  const relative = (path: string): string => repoPath(layout, path);
  const changed = project
    .getSourceFiles()
    .filter((file) => !file.isSaved() && !ctx.created.has(file.getFilePath()))
    .map((file) => relative(file.getFilePath()));
  const reportPath = join(layout.root, REPORT_FILE);
  const reportExists = existsSync(reportPath);
  const reportChanged = !reportExists || readFileSync(reportPath, "utf8") !== report.text;
  if (options.dryRun !== true) {
    project.saveSync();
    if (reportChanged) {
      writeFileSync(reportPath, report.text);
    }
  }
  const created = [...ctx.created].map(relative);
  return {
    stats: ctx.stats,
    // The report is created by the first run, and changed by a later one that finds other markers.
    changed: reportExists && reportChanged ? [...changed, REPORT_FILE] : changed,
    created: reportExists ? created : [...created, REPORT_FILE],
    deleted: [...ctx.deleted].map(relative),
    report: report.text,
    items: report.count,
  };
}
