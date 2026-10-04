import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { Options } from "./cli";
import { DRIVERS, type Driver } from "./drivers";
import { generateClient } from "./env/app";
import { appCoreVersion, cpusAllowed, pinSelf } from "./env/machine";
import { log } from "./log";
import { appDir, BASELINES_DIR, REPORTS_DIR, RESULTS_DIR } from "./paths";
import { buildWorkload, type Workload } from "./workload";

/** Everything a run needs before the database and the first server start. */
export interface Prepared {
  /** What the results are filed under: `--label`, else the installed quickdraw-core version. */
  label: string;
  /** The quickdraw-core version the app installs. */
  coreVersion: string;
  appDirectory: string;
  /** The client that speaks the target app's protocol. */
  driver: Driver;
  logDirectory: string;
  /** Where server CPU profiles go when `--cpu-prof` is on. */
  profileDirectory: string | null;
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
  const name = `${stamp}-${options.target}${options.quick ? "-quick" : ""}`;
  return { json: join(RESULTS_DIR, `${name}.json`), markdown: join(RESULTS_DIR, `${name}.md`) };
}

/** Pin the load generator, write the workload file and generate the app's Prisma client. */
export async function prepare(options: Options, startedAt: number): Promise<Prepared> {
  if (options.baseline && options.quick)
    throw new Error("a --quick run cannot be written as a baseline");
  pinSelf(options.loadgenCpus);
  log(`load generator pinned to cpus ${cpusAllowed("self") ?? "unknown"}`);
  const appDirectory = appDir(options.target);
  const coreVersion = appCoreVersion(appDirectory);
  const label = options.label ?? coreVersion;
  const stamp = new Date(startedAt).toISOString().replace(/[:.]/g, "-").slice(0, 19);
  const logDirectory = join(RESULTS_DIR, "logs", stamp);
  await mkdir(logDirectory, { recursive: true });
  const profileDirectory = options.cpuProf ? join(logDirectory, "profiles") : null;
  if (profileDirectory !== null) await mkdir(profileDirectory, { recursive: true });
  const workload = buildWorkload();
  const workloadPath = join(RESULTS_DIR, "workload.json");
  await writeFile(workloadPath, JSON.stringify(workload));
  log(
    `target ${options.target} (quickdraw-core ${coreVersion}, filed as ${label}); server logs in ${logDirectory}`,
  );
  await generateClient(appDirectory);
  return {
    label,
    coreVersion,
    appDirectory,
    driver: DRIVERS[options.target],
    logDirectory,
    profileDirectory,
    workload,
    workloadPath,
    outputs: outputPaths(options, label, stamp),
  };
}
