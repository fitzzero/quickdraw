import { assemble } from "./assemble";
import { parseOptions } from "./cli";
import type { BenchResult, Repetition } from "./result-schema";
import { buildWorkload } from "./workload";

/**
 * Result files built the way the runner builds them, for the harness's unit
 * tests (`*.test.ts`). Nothing here runs a server.
 */

export interface RepetitionValues {
  p95: number;
  cpuSeconds: number;
  bytesSent?: number;
  sqlStatements?: number;
  handlerRuns?: Record<string, number>;
  snapshots?: { collection: number; entity: number };
}

export function repetition(index: number, values: RepetitionValues): Repetition {
  const { p95, cpuSeconds } = values;
  return {
    index,
    startedAt: `2026-10-02T20:0${index}:00.000Z`,
    loadAverage: { one: 1.2, five: 1.1, fifteen: 1 },
    completed: true,
    outcome: "600 writes issued over 60.0 s",
    windowMs: 60_500,
    requests: {
      "taskService:updateTask": {
        sent: 600,
        succeeded: 598,
        timeout: 1,
        error: 1,
        abandoned: 0,
        unanswered: 0,
        late: 1,
      },
    },
    failedRequests: 2,
    latencyMs: {
      "taskService:updateTask": { count: 598, p50: 3, p95, p99: p95 * 2, max: p95 * 3, mean: 4 },
    },
    deliveryMs: {
      collectionDelta: { count: 29_900, p50: 3, p95: 8, p99: 12, max: 40, mean: 4 },
    },
    server: {
      windowMs: 60_400,
      cpuUserSeconds: cpuSeconds - 1,
      cpuSystemSeconds: 1,
      cpuSeconds,
      eventLoopDelayMs: { p50: 10, p99: 25, max: 60, mean: 11 },
      bytesSent: values.bytesSent ?? 1_000_000,
      bytesReceived: 50_000,
      sqlStatements: values.sqlStatements ?? 1_800,
      snapshotsServed: {
        collectionPages: 0,
        ...(values.snapshots ?? { collection: 0, entity: 0 }),
      },
      handlerRuns: values.handlerRuns ?? { "taskService:updateTask": 600 },
      inFlight: 0,
      rssPeakMb: 300,
      connections: 55,
    },
    serverError: null,
    loadgen: { cpuSeconds: 2, eventLoopDelayP99Ms: 11, eventLoopDelayMaxMs: 15 },
    noise: {
      otherWorkOnServerCpusPct: index / 2,
      interruptsOnServerCpusPct: 2,
      restOfMachineBusyPct: 4,
    },
    scenario: { writesIssued: 600, drainSeconds: 0.3 },
    errors: ["taskService:updateTask: Insufficient permissions"],
  };
}

export interface SampleOptions {
  target?: "v4" | "v5";
  label?: string;
  repetitions?: Repetition[];
  startedAt?: string;
}

export function sampleResult(options: SampleOptions = {}): BenchResult {
  const target = options.target ?? "v4";
  const version = target === "v4" ? "4.1.0" : "5.0.0-alpha.0";
  const parsed = parseOptions(["--scenario", "board-steady", "--baseline", "--target", target]);
  return assemble({
    options: parsed,
    label: options.label ?? version,
    coreVersion: version,
    startedAt: Date.parse(options.startedAt ?? "2026-10-02T20:00:00.000Z"),
    machine: {
      hostname: "bench-host",
      cpuModel: "Test CPU",
      nproc: 24,
      kernel: "7.0.0",
      os: "Linux",
      totalMemoryGb: 32,
      cpuGovernor: "performance",
      cpuBoost: "1",
    },
    runtime: { node: "v24.0.0", bun: "1.3.10", docker: "29.0.0", socketIoClient: "4.8.4" },
    database: {
      url: "postgresql://bench@127.0.0.1:5544/x",
      startedHere: true,
      cpus: "6-9",
      version: "16.13",
    },
    info: {
      app: target,
      pid: 1,
      node: "v24.0.0",
      versions: { "@fitzzero/quickdraw-core": version },
      dbPoolMax: 10,
      logging: `${target} defaults`,
    },
    workload: buildWorkload(),
    order: ["board-steady#1", "board-steady#2", "board-steady#3"],
    runs: new Map([
      [
        "board-steady",
        {
          parameters: { viewers: 50, writers: 5 },
          repetitions: options.repetitions ?? [
            repetition(1, { p95: 10, cpuSeconds: 30 }),
            repetition(2, { p95: 14, cpuSeconds: 34 }),
            repetition(3, { p95: 12, cpuSeconds: 31 }),
          ],
        },
      ],
    ]),
  });
}
