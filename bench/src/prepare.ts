import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { Options } from "./cli";
import { generateClient } from "./env/app";
import { appCoreVersion, cpusAllowed, pinSelf } from "./env/machine";
import { log } from "./log";
import { appDir, BASELINES_DIR, REPORTS_DIR, RESULTS_DIR } from "./paths";
import { buildWorkload, type Workload } from "./workload";

/** Everything a run needs before the database and the first server start. */
export interface Prepared {
  label: string;
  appDirectory: string;
  logDirectory: string;
  workload: Workload;
  workloadPath: string;
  outputs: { json: string; markdown: string };
}

function outputPaths(options: Options, label: string, stamp: string): Prepared["outputs"] {
  if (options.baseline) {
    return {
      json: join(BASELINES_DIR, `${label}.json`),
      markdown: join(REPORTS_DIR, `${label}.md`),
    };
  }
  const name = `${stamp}-${options.app}${options.quick ? "-quick" : ""}`;
  return { json: join(RESULTS_DIR, `${name}.json`), markdown: join(RESULTS_DIR, `${name}.md`) };
}

/** Pin the load generator, write the workload file and generate the app's Prisma client. */
export async function prepare(options: Options, startedAt: number): Promise<Prepared> {
  if (options.baseline && options.quick)
    throw new Error("a --quick run cannot be written as a baseline");
  pinSelf(options.loadgenCpus);
  log(`load generator pinned to cpus ${cpusAllowed("self") ?? "unknown"}`);
  const appDirectory = appDir(options.app);
  const label = appCoreVersion(appDirectory);
  const stamp = new Date(startedAt).toISOString().replace(/[:.]/g, "-").slice(0, 19);
  const logDirectory = join(RESULTS_DIR, "logs", stamp);
  await mkdir(logDirectory, { recursive: true });
  const workload = buildWorkload();
  const workloadPath = join(RESULTS_DIR, "workload.json");
  await writeFile(workloadPath, JSON.stringify(workload));
  log(`app ${options.app} (quickdraw-core ${label}); server logs in ${logDirectory}`);
  await generateClient(appDirectory);
  return {
    label,
    appDirectory,
    logDirectory,
    workload,
    workloadPath,
    outputs: outputPaths(options, label, stamp),
  };
}
