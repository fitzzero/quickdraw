import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import Ajv2020 from "ajv/dist/2020";
import { describe, expect, it } from "vitest";
import { sampleResult } from "./fixtures";
import { BASELINES_DIR, COMPARISONS_DIR, SCHEMA_FILE } from "./paths";
import { renderMarkdown } from "./report";
import { resultJsonSchema, resultSchema } from "./result-schema";

const committedSchema = JSON.parse(readFileSync(SCHEMA_FILE, "utf8")) as Record<string, unknown>;
const validate = new Ajv2020({ allErrors: true }).compile(committedSchema);

/** Every committed result file: the baselines, and the runs each comparison was made from. */
function committedResults(): string[] {
  const jsonIn = (dir: string): string[] =>
    existsSync(dir)
      ? readdirSync(dir, { recursive: true, encoding: "utf8" })
          .filter((file) => file.endsWith(".json"))
          .map((file) => join(dir, file))
      : [];
  return [...jsonIn(BASELINES_DIR), ...jsonIn(COMPARISONS_DIR)];
}

describe("result schema", () => {
  it("matches the committed JSON Schema (run `bun run --filter bench schema` after changing it)", () => {
    expect(committedSchema).toEqual(resultJsonSchema());
  });

  it("accepts a result assembled the way the runner assembles one", () => {
    for (const target of ["v4", "v5"] as const) {
      const result = { $schema: "../result.schema.json", ...sampleResult({ target }) };
      expect(validate(result), JSON.stringify(validate.errors)).toBe(true);
      expect(resultSchema.safeParse(result).success).toBe(true);
    }
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

  it("validates every committed result file", () => {
    const files = committedResults();
    expect(files.length).toBeGreaterThan(0);
    for (const file of files) {
      const result = JSON.parse(readFileSync(file, "utf8")) as unknown;
      expect(validate(result), `${file}: ${JSON.stringify(validate.errors)}`).toBe(true);
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
    expect(markdown).toContain(
      "other processes and kernel threads used 0.5% to 1.5% (median 1.0%)",
    );
    expect(markdown).toContain("| board-steady | updateTask 12 | 2 | 31 |");
    expect(markdown).toContain("| board-steady#2 | 20:02:00 | 1.20 | 1.0% | 4.0% |");
  });

  it("notes how each target's client and server ran", () => {
    expect(sampleResult({ target: "v4" }).notes.join(" ")).toContain("10 s the 4.1 hooks wait");
    const v5 = sampleResult({ target: "v5" });
    expect(v5.notes.join(" ")).toContain("callTimeoutMs plus 2 s");
    expect(v5.app).toMatchObject({ name: "v5", quickdrawCore: "5.0.0-alpha.0" });
  });
});
