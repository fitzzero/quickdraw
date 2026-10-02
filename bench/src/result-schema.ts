import { z } from "zod";
import { SCENARIO_NAMES } from "./scenarios/types";

/**
 * The result file every run writes (bench/baselines/<version>.json for a
 * baseline). `bench/result.schema.json` is generated from this schema with
 * `bun run --filter bench schema`; a unit test keeps the two in step.
 */

const count = z.number().int().nonnegative();
const nullableNumber = z.number().nullable();

const latencyStats = z.object({
  count,
  p50: nullableNumber,
  p95: nullableNumber,
  p99: nullableNumber,
  max: nullableNumber,
  mean: nullableNumber,
});

const requestCounts = z.object({
  sent: count,
  succeeded: count,
  timeout: count,
  error: count,
  abandoned: count,
  unanswered: count,
  late: count,
});

const serverMetrics = z.object({
  windowMs: z.number(),
  cpuUserSeconds: z.number(),
  cpuSystemSeconds: z.number(),
  cpuSeconds: z.number(),
  eventLoopDelayMs: z.object({
    p50: z.number(),
    p99: z.number(),
    max: z.number(),
    mean: z.number(),
  }),
  bytesSent: count,
  bytesReceived: count,
  sqlStatements: count,
  snapshotsServed: z.object({ collection: count, collectionPages: count, entity: count }),
  handlerRuns: z.record(z.string(), count),
  inFlight: count,
  rssPeakMb: z.number(),
  connections: count,
});

const repetition = z.object({
  index: z.number().int().positive(),
  startedAt: z.string(),
  loadAverage: z.object({ one: z.number(), five: z.number(), fifteen: z.number() }),
  completed: z.boolean(),
  outcome: z.string(),
  windowMs: z.number(),
  requests: z.record(z.string(), requestCounts),
  failedRequests: count,
  latencyMs: z.record(z.string(), latencyStats),
  deliveryMs: z.record(z.string(), latencyStats),
  server: serverMetrics.nullable(),
  serverError: z.string().nullable(),
  loadgen: z.object({
    cpuSeconds: z.number(),
    eventLoopDelayP99Ms: z.number(),
    eventLoopDelayMaxMs: z.number(),
  }),
  noise: z
    .object({
      otherWorkOnServerCpusPct: z.number(),
      interruptsOnServerCpusPct: z.number(),
      restOfMachineBusyPct: z.number(),
    })
    .nullable(),
  scenario: z.record(z.string(), nullableNumber),
  errors: z.array(z.string()),
});

const summaryEntry = z.object({
  values: z.array(nullableNumber),
  median: nullableNumber,
  min: nullableNumber,
  max: nullableNumber,
  /** (max - min) / median, as a percentage; null when the median is 0 or missing. */
  spreadPct: nullableNumber,
});

const scenarioResult = z.object({
  name: z.enum(SCENARIO_NAMES),
  description: z.string(),
  parameters: z.record(z.string(), z.number()),
  repetitions: z.array(repetition).min(1),
  summary: z.record(z.string(), summaryEntry),
});

const cpuLimit = z.object({
  method: z.string(),
  cpus: z.string(),
  cpuCount: count,
  detail: z.string(),
});

export const resultSchema = z.object({
  $schema: z.string().optional(),
  schemaVersion: z.literal(1),
  kind: z.enum(["baseline", "run"]),
  label: z.string(),
  quick: z.boolean(),
  command: z.string(),
  createdAt: z.string(),
  totalDurationMs: z.number(),
  app: z.object({
    name: z.string(),
    quickdrawCore: z.string(),
    versions: z.record(z.string(), z.string()),
    dbPoolMax: count,
    logging: z.string(),
  }),
  machine: z.object({
    hostname: z.string(),
    cpuModel: z.string(),
    nproc: count,
    kernel: z.string(),
    os: z.string(),
    totalMemoryGb: z.number(),
    cpuGovernor: z.string().nullable(),
    cpuBoost: z.string().nullable(),
  }),
  runtime: z.object({
    node: z.string(),
    bun: z.string().nullable(),
    docker: z.string().nullable(),
    postgres: z.string().nullable(),
    socketIoClient: z.string().nullable(),
  }),
  limits: z.object({ server: cpuLimit, loadgen: cpuLimit, postgres: cpuLimit }),
  workload: z.record(z.string(), z.number()),
  order: z.array(z.string()),
  notes: z.array(z.string()),
  notMeasured: z.array(z.string()),
  scenarios: z.array(scenarioResult).min(1),
});

export type BenchResult = z.infer<typeof resultSchema>;
export type ScenarioResult = z.infer<typeof scenarioResult>;
export type Repetition = z.infer<typeof repetition>;
export type SummaryEntry = z.infer<typeof summaryEntry>;

/** The JSON Schema document for result files (draft 2020-12). */
export function resultJsonSchema(): Record<string, unknown> {
  return z.toJSONSchema(resultSchema, { target: "draft-2020-12" }) as Record<string, unknown>;
}
