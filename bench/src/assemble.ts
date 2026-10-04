import type { Options } from "./cli";
import { TARGET_NOTES } from "./drivers/notes";
import type { AppInfo } from "./env/app";
import type { Database } from "./env/database";
import { expandCpus, type Machine, type Runtime } from "./env/machine";
import type { BenchResult, Repetition, ScenarioResult } from "./result-schema";
import { SCENARIOS, type ScenarioName } from "./scenarios";
import { summarizeRepetitions } from "./summary";
import { describeWorkload, type Workload } from "./workload";

/**
 * How every number in a result file was taken, whatever the target. Shown in
 * the report, followed by the target's own notes (its driver's `notes`).
 */
export const NOTES = [
  "Client latency is timed in the load generator from emit to acknowledgement, only for calls answered successfully within the client's timeout; every other call is counted by kind, not timed. Calls abandoned because the client itself dropped the connection are counted separately and are not failures.",
  "Delivery is the time from a writer emitting updateTask to a viewer receiving that change (collection delta or entity update), on the load generator's single clock.",
  "Server CPU is process.cpuUsage() of the server process over the window. Event-loop delay is how late a 10 ms perf_hooks.monitorEventLoopDelay timer fired (the histogram value minus its 10 ms interval). Bytes are TCP bytes the server wrote, including HTTP and WebSocket framing.",
  "SQL statements are the Prisma client's query events: every statement the server sent, access checks and the reads that build live frames included.",
  "Machine noise comes from /proc: the time other processes spent on the server's pinned cpus during each window (those cpus' busy time minus the server process's own), and how busy the cpus the benchmark did not use were. Interrupt time on the server's cpus, mostly the benchmark's own network traffic, is kept apart in the result file.",
  "Every run starts a fresh server process on a freshly seeded database.",
  "Writes are open-loop: they are issued on schedule whether or not earlier writes have been answered, so a slow server cannot reduce the offered load.",
];

export interface AssembleInput {
  options: Options;
  label: string;
  /** The quickdraw-core version the app installs (the label unless `--label` named another). */
  coreVersion: string;
  startedAt: number;
  machine: Machine;
  runtime: Runtime;
  database: Database;
  info: AppInfo;
  workload: Workload;
  order: string[];
  runs: Map<ScenarioName, { parameters: Record<string, number>; repetitions: Repetition[] }>;
}

function limits(input: AssembleInput): BenchResult["limits"] {
  const { options, database } = input;
  const pgCpus = database.cpus ?? options.pgCpus;
  const profiled = options.cpuProf ? ", profiled with --cpu-prof" : "";
  return {
    server: {
      method: "taskset",
      cpus: options.serverCpus,
      cpuCount: expandCpus(options.serverCpus).length,
      detail: `taskset -c ${options.serverCpus} node --import tsx src/server.ts (${expandCpus(options.serverCpus).length} CPUs, affinity checked in /proc/<pid>/status${profiled})`,
    },
    loadgen: {
      method: "taskset",
      cpus: options.loadgenCpus,
      cpuCount: expandCpus(options.loadgenCpus).length,
      detail: `the runner pins itself with taskset -a -cp ${options.loadgenCpus}; every simulated client is a socket.io-client connection in that one Node process`,
    },
    postgres: {
      method: "docker cpuset",
      cpus: pgCpus,
      cpuCount: expandCpus(pgCpus).length,
      detail: `Docker container (compose project quickdraw-bench) with cpuset ${pgCpus}, data in tmpfs`,
    },
  };
}

function notMeasured(scenarios: ScenarioResult[]): string[] {
  return scenarios.flatMap((scenario) =>
    scenario.repetitions
      .filter((rep) => rep.server === null)
      .map(
        (rep) =>
          `${scenario.name} repetition ${rep.index}: server metrics (${rep.serverError ?? "unknown reason"})`,
      ),
  );
}

export function assemble(input: AssembleInput): BenchResult {
  const scenarios: ScenarioResult[] = [...input.runs].map(([name, run]) => ({
    name,
    description: SCENARIOS[name].description,
    parameters: run.parameters,
    repetitions: run.repetitions,
    summary: summarizeRepetitions(run.repetitions),
  }));
  const args = input.options.args.join(" ");
  return {
    schemaVersion: 1,
    kind: input.options.baseline ? "baseline" : "run",
    label: input.label,
    quick: input.options.quick,
    command: `bun run --filter bench bench${args ? ` -- ${args}` : ""}`,
    createdAt: new Date(input.startedAt).toISOString(),
    totalDurationMs: Date.now() - input.startedAt,
    app: {
      name: input.options.target,
      quickdrawCore: input.coreVersion,
      versions: input.info.versions,
      dbPoolMax: input.info.dbPoolMax,
      logging: input.info.logging,
    },
    machine: input.machine,
    runtime: { ...input.runtime, postgres: input.database.version },
    limits: limits(input),
    workload: describeWorkload(input.workload),
    order: input.order,
    notes: [...NOTES, ...TARGET_NOTES[input.options.target]],
    notMeasured: notMeasured(scenarios),
    scenarios,
  };
}
