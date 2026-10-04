import { join } from "node:path";
import { AppServer, seed, type AppInfo } from "./env/app";
import { loadAverage } from "./env/machine";
import { assertPortFree } from "./env/ports";
import { measure, serverInFlight, type CpuSets } from "./measure";
import { Recorder } from "./recorder";
import type { Repetition } from "./result-schema";
import type { Scenario, ScenarioContext, ScenarioRun } from "./scenarios";
import { round } from "./stats";
import type { Workload } from "./workload";

/**
 * One repetition of one scenario: reseed the database, start a fresh server
 * pinned to its cpus, run the scenario, stop the server.
 */

export interface RunSetup {
  appDirectory: string;
  driver: ScenarioContext["driver"];
  databaseUrl: string;
  workload: Workload;
  workloadPath: string;
  logDirectory: string;
  /** Where to write a CPU profile of each server, or null for none. */
  profileDirectory: string | null;
  port: number;
  serverCpus: string;
  cpuSets: CpuSets;
  quick: boolean;
  log(message: string): void;
  /** Called with the running server so a signal handler can stop it. */
  track(server: AppServer | null): void;
}

export interface RunRecord {
  repetition: Repetition;
  parameters: Record<string, number>;
  info: AppInfo;
}

function toRepetition(
  index: number,
  startedAt: string,
  load: Repetition["loadAverage"],
  run: ScenarioRun,
  exit: number | null,
): Repetition {
  const m = run.measurement;
  return {
    index,
    startedAt,
    loadAverage: load,
    completed: run.completed && exit === null,
    outcome: exit === null ? run.outcome : `${run.outcome}; the server process exited with ${exit}`,
    windowMs: round(m.windowMs),
    requests: m.requests,
    failedRequests: m.failedRequests,
    latencyMs: m.latencyMs,
    deliveryMs: m.deliveryMs,
    server: m.server,
    serverError: m.serverError,
    loadgen: m.loadgen,
    noise: m.noise,
    scenario: run.metrics,
    errors: m.errors,
  };
}

/** A repetition whose scenario threw before it produced a measurement (a result, not a crash). */
function notRun(
  index: number,
  startedAt: string,
  load: Repetition["loadAverage"],
  error: unknown,
): Repetition {
  const message = error instanceof Error ? error.message : String(error);
  return {
    index,
    startedAt,
    loadAverage: load,
    completed: false,
    outcome: `did not run to a measurement: ${message}`,
    windowMs: 0,
    requests: {},
    failedRequests: 0,
    latencyMs: {},
    deliveryMs: {},
    server: null,
    serverError: "no measurement window was opened",
    loadgen: { cpuSeconds: 0, eventLoopDelayP99Ms: 0, eventLoopDelayMaxMs: 0 },
    noise: null,
    scenario: {},
    errors: [message],
  };
}

export async function runOnce(
  setup: RunSetup,
  scenario: Scenario,
  index: number,
): Promise<RunRecord> {
  await seed(setup.appDirectory, setup.databaseUrl, setup.workloadPath);
  await assertPortFree(setup.port, "0.0.0.0", "bench server");
  const server = await AppServer.start({
    appDir: setup.appDirectory,
    port: setup.port,
    cpus: setup.serverCpus,
    databaseUrl: setup.databaseUrl,
    logFile: join(setup.logDirectory, `${scenario.name}-r${index}.log`),
    ...(setup.profileDirectory === null
      ? {}
      : {
          profile: { dir: setup.profileDirectory, name: `${scenario.name}-r${index}.cpuprofile` },
        }),
  });
  setup.track(server);
  const parameters = scenario.parameters(setup.quick);
  try {
    const info = await server.info();
    const recorder = new Recorder();
    const ctx: ScenarioContext = {
      url: server.url,
      tokens: await server.tokens(),
      workload: setup.workload,
      recorder,
      driver: setup.driver,
      log: setup.log,
      measure: async (work) => await measure(server, recorder, setup.cpuSets, work),
      serverInFlight: async () => await serverInFlight(server),
    };
    const load = loadAverage();
    const startedAt = new Date().toISOString();
    try {
      const run = await scenario.run(ctx, parameters);
      return {
        repetition: toRepetition(index, startedAt, load, run, server.exitStatus),
        parameters,
        info,
      };
    } catch (error) {
      return { repetition: notRun(index, startedAt, load, error), parameters, info };
    }
  } finally {
    await server.stop();
    setup.track(null);
  }
}
