import { assemble, type AssembleInput } from "./assemble";
import type { Options } from "./cli";
import type { AppInfo, AppServer } from "./env/app";
import { ensureDatabase, stopDatabase, type Database } from "./env/database";
import { describeMachine, runtimeVersions } from "./env/machine";
import { log } from "./log";
import { prepare } from "./prepare";
import { writeResult } from "./report";
import { runOnce, type RunSetup } from "./run-once";
import { SCENARIOS } from "./scenarios";

/** Stop whatever this run started when it is interrupted. */
function onInterrupt(cleanup: () => Promise<void>): void {
  const handler = (signal: NodeJS.Signals): void => {
    log(`${signal}: stopping the server and the database this run started`);
    void cleanup().finally(() => process.exit(130));
  };
  process.once("SIGINT", handler);
  process.once("SIGTERM", handler);
}

type Base = Omit<AssembleInput, "info" | "order" | "runs">;

/** Every scenario once per repetition, interleaved, so machine noise spreads across scenarios. */
async function runAll(options: Options, base: Base, setup: RunSetup): Promise<AssembleInput> {
  const order: string[] = [];
  const runs: AssembleInput["runs"] = new Map();
  let info: AppInfo | null = null;
  for (let rep = 1; rep <= options.repetitions; rep += 1) {
    for (const name of options.scenarios) {
      log(`${name} repetition ${rep}/${options.repetitions}`);
      const record = await runOnce(setup, SCENARIOS[name], rep);
      info = record.info;
      order.push(`${name}#${rep}`);
      const entry = runs.get(name) ?? { parameters: record.parameters, repetitions: [] };
      entry.repetitions.push(record.repetition);
      runs.set(name, entry);
      const state = record.repetition.completed ? "completed" : "did not complete";
      log(`  ${state}: ${record.repetition.outcome}`);
    }
  }
  if (!info) throw new Error("no run produced app info");
  return { ...base, info, order, runs };
}

export async function orchestrate(options: Options): Promise<void> {
  const startedAt = Date.now();
  const prepared = await prepare(options, startedAt);
  let database: Database | null = null;
  let server: AppServer | null = null;
  const cleanup = async (): Promise<void> => {
    await server?.stop();
    if (database?.startedHere && !options.keepDb) await stopDatabase();
  };
  onInterrupt(cleanup);
  try {
    database = await ensureDatabase({
      port: options.pgPort,
      cpus: options.pgCpus,
      appDir: prepared.appDirectory,
    });
    log(`postgres ${database.version ?? "?"} at ${database.url} (cpuset ${database.cpus ?? "?"})`);
    const setup: RunSetup = {
      ...prepared,
      databaseUrl: database.url,
      port: options.port,
      serverCpus: options.serverCpus,
      quick: options.quick,
      log,
      track: (running) => {
        server = running;
      },
    };
    const base: Base = {
      options,
      label: prepared.label,
      startedAt,
      machine: describeMachine(options.serverCpus),
      runtime: runtimeVersions(),
      database,
      workload: prepared.workload,
    };
    const result = assemble(await runAll(options, base, setup));
    await writeResult(result, prepared.outputs.json, prepared.outputs.markdown);
    const minutes = (result.totalDurationMs / 60_000).toFixed(1);
    log(`wrote ${prepared.outputs.json} and ${prepared.outputs.markdown} (${minutes} min)`);
  } finally {
    await cleanup();
  }
}
