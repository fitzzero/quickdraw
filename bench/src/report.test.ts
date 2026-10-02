import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import Ajv2020 from "ajv/dist/2020";
import { describe, expect, it } from "vitest";
import { assemble } from "./assemble";
import { parseOptions } from "./cli";
import { BASELINES_DIR, SCHEMA_FILE } from "./paths";
import { renderMarkdown } from "./report";
import { resultJsonSchema, resultSchema, type BenchResult, type Repetition } from "./result-schema";
import { buildWorkload } from "./workload";

const committedSchema = JSON.parse(readFileSync(SCHEMA_FILE, "utf8")) as Record<string, unknown>;
const validate = new Ajv2020({ allErrors: true }).compile(committedSchema);

function repetition(index: number, p95: number, cpuSeconds: number): Repetition {
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
      bytesSent: 1_000_000,
      bytesReceived: 50_000,
      sqlStatements: 1_800,
      snapshotsServed: { collection: 0, collectionPages: 0, entity: 0 },
      handlerRuns: { "taskService:updateTask": 600 },
      inFlight: 0,
      rssPeakMb: 300,
      connections: 55,
    },
    serverError: null,
    loadgen: { cpuSeconds: 2, eventLoopDelayP99Ms: 11, eventLoopDelayMaxMs: 15 },
    scenario: { writesIssued: 600, drainSeconds: 0.3 },
    errors: ["taskService:updateTask: Insufficient permissions"],
  };
}

function sampleResult(): BenchResult {
  const options = parseOptions(["--scenario", "board-steady", "--baseline"]);
  return assemble({
    options,
    label: "4.1.0",
    startedAt: Date.parse("2026-10-02T20:00:00.000Z"),
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
      app: "v4",
      pid: 1,
      node: "v24.0.0",
      versions: { "@fitzzero/quickdraw-core": "4.1.0" },
      dbPoolMax: 10,
      logging: "4.1 defaults",
    },
    workload: buildWorkload(),
    order: ["board-steady#1", "board-steady#2", "board-steady#3"],
    runs: new Map([
      [
        "board-steady",
        {
          parameters: { viewers: 50, writers: 5 },
          repetitions: [repetition(1, 10, 30), repetition(2, 14, 34), repetition(3, 12, 31)],
        },
      ],
    ]),
  });
}

describe("result schema", () => {
  it("matches the committed JSON Schema (run `bun run --filter bench schema` after changing it)", () => {
    expect(committedSchema).toEqual(resultJsonSchema());
  });

  it("accepts a result assembled the way the runner assembles one", () => {
    const result = { $schema: "../result.schema.json", ...sampleResult() };
    expect(validate(result), JSON.stringify(validate.errors)).toBe(true);
    expect(resultSchema.safeParse(result).success).toBe(true);
  });

  it("rejects a result without its machine description or with a bad repetition", () => {
    const { machine: _machine, ...withoutMachine } = sampleResult();
    expect(validate(withoutMachine)).toBe(false);

    const broken = sampleResult();
    const rep = broken.scenarios[0]?.repetitions[0];
    if (!rep) throw new Error("sample has no repetition");
    (rep as unknown as Record<string, unknown>).failedRequests = -1;
    expect(validate(broken)).toBe(false);
  });

  it("validates every committed baseline", () => {
    const files = existsSync(BASELINES_DIR)
      ? readdirSync(BASELINES_DIR).filter((file) => file.endsWith(".json"))
      : [];
    for (const file of files) {
      const baseline = JSON.parse(readFileSync(join(BASELINES_DIR, file), "utf8")) as unknown;
      expect(validate(baseline), `${file}: ${JSON.stringify(validate.errors)}`).toBe(true);
    }
  });
});

describe("summary", () => {
  it("reports the median of the repetitions and how far they spread", () => {
    const summary = sampleResult().scenarios[0]?.summary ?? {};
    expect(summary["latency.taskService:updateTask.p95"]).toEqual({
      values: [10, 14, 12],
      median: 12,
      min: 10,
      max: 14,
      spreadPct: 33.3,
    });
    expect(summary["server.cpuSeconds"]?.median).toBe(31);
    expect(summary["requests.taskService:updateTask.failed"]?.median).toBe(2);
  });

  it("renders a report naming the setup, every scenario and the noise on the machine", () => {
    const markdown = renderMarkdown(sampleResult(), "../baselines/4.1.0.json");
    expect(markdown).toContain("# quickdraw-core 4.1.0 benchmark baseline");
    expect(markdown).toContain("### board-steady");
    expect(markdown).toContain("| updateTask p95 (ms) | 12 | 10 | 14 | 33.3% |");
    expect(markdown).toContain("load average");
  });
});
