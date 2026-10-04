import { describe, expect, it } from "vitest";
import { betterFor, canonicalKey, compare, mismatches, rowOf } from "./compare";
import { analysisOf, renderComparison } from "./compare-report";
import { repetition, sampleResult } from "./fixtures";

const SOURCES = { before: "a.json", after: "b.json", again: "c.json" };

function oldRun(startedAt: string, p95: number) {
  return sampleResult({
    target: "v4",
    startedAt,
    repetitions: [1, 2, 3].map((index) =>
      repetition(index, {
        p95,
        cpuSeconds: 30,
        bytesSent: 6_000_000,
        handlerRuns: { "taskService:batchSubscribe": 50 },
      }),
    ),
  });
}

function newRun(p95: number, cpuSeconds: number) {
  return sampleResult({
    target: "v5",
    label: "5.0.0",
    startedAt: "2026-10-02T20:10:00.000Z",
    repetitions: [1, 2, 3].map((index) =>
      repetition(index, {
        p95,
        cpuSeconds,
        bytesSent: 1_200_000,
        handlerRuns: { "taskService:qd:sub": 50, "taskService:qd:watch": 50 },
      }),
    ),
  });
}

describe("canonical metric names", () => {
  it("puts 4.1's and 5.0's names for one thing under one key", () => {
    expect(canonicalKey("latency.taskService:batchSubscribe.p95")).toBe(
      "latency.taskService:entity subscribe.p95",
    );
    expect(canonicalKey("latency.taskService:qd:sub.p95")).toBe(
      "latency.taskService:entity subscribe.p95",
    );
    expect(canonicalKey("requests.taskService:collection:subscribe.sent")).toBe(
      canonicalKey("requests.taskService:qd:col:sub.sent"),
    );
    expect(canonicalKey("server.handlerRuns.taskService:qd:unsub")).toBe(
      "server.handlerRuns.taskService:entity unsubscribe",
    );
    expect(canonicalKey("latency.taskService:getTasksByStatus.p95")).toBe(
      "latency.taskService:getTasksByStatus.p95",
    );
    expect(canonicalKey("server.cpuSeconds")).toBe("server.cpuSeconds");
  });

  it("knows which way is better", () => {
    expect(betterFor("latency.taskService:updateTask.p95")).toBe("lower");
    expect(betterFor("requests.taskService:updateTask.failed")).toBe("lower");
    expect(betterFor("requests.taskService:updateTask.sent")).toBe("none");
    expect(betterFor("server.snapshots.entity")).toBe("lower");
    expect(betterFor("server.snapshots.entityNotModified")).toBe("none");
    expect(betterFor("scenario.restored")).toBe("higher");
    expect(betterFor("scenario.restoreP95Ms")).toBe("lower");
    expect(betterFor("scenario.writesIssued")).toBe("none");
    expect(betterFor("loadgen.cpuSeconds")).toBe("none");
  });
});

describe("a metric row", () => {
  it("is worse only when the new run is worse than both old runs", () => {
    expect(rowOf("server.cpuSeconds", 10, 11, 12)).toMatchObject({ worse: false, ratio: 1 });
    expect(rowOf("server.cpuSeconds", 10, 13, 12)).toMatchObject({ worse: true, ratio: 1.182 });
    expect(rowOf("scenario.restored", 190, 180, 190)).toMatchObject({ worse: true });
    expect(rowOf("requests.taskService:updateTask.sent", 600, 900, 600).worse).toBe(false);
  });

  it("is noisy when the old runs differ by more than 10% of their mean", () => {
    expect(rowOf("server.cpuSeconds", 10, 10, 10.9)).toMatchObject({ noisy: false, drift: 0.086 });
    expect(rowOf("server.cpuSeconds", 10, 10, 11.2)).toMatchObject({ noisy: true, drift: 0.113 });
    expect(rowOf("server.cpuSeconds", 0, 0, 0)).toMatchObject({
      noisy: false,
      drift: null,
      ratio: null,
    });
    expect(rowOf("server.cpuSeconds", null, 5, 3)).toMatchObject({ ratio: null, worse: false });
  });
});

describe("a comparison", () => {
  const before = oldRun("2026-10-02T20:00:00.000Z", 100);
  const again = oldRun("2026-10-02T20:20:00.000Z", 104);

  it("refuses runs that do not match", () => {
    const other = newRun(40, 20);
    const quick = { ...other, quick: true };
    const moved = {
      ...other,
      limits: { ...other.limits, server: { ...other.limits.server, cpus: "4,5" } },
    };
    expect(mismatches(before, other, again)).toEqual([]);
    expect(mismatches(before, quick, again)).toContain("the new run is a --quick run");
    expect(mismatches(before, moved, again)).toContain("the CPU limits differ between the runs");
    expect(() => compare(before, moved, again)).toThrow("cannot be compared");
  });

  it("lines up every metric of both versions, with per-write costs", () => {
    const comparison = compare(before, newRun(40, 20), again);
    const rows = comparison.scenarios[0]?.rows ?? [];
    const row = (key: string) => rows.find((entry) => entry.key === key);
    expect(row("latency.taskService:updateTask.p95")).toMatchObject({
      first: 100,
      next: 40,
      second: 104,
      ratio: 0.392,
      worse: false,
    });
    expect(row("server.handlerRuns.taskService:entity subscribe")).toMatchObject({
      first: 50,
      next: 50,
      second: 50,
    });
    // 4.1 never watches a topic: it counted none, and the row is not judged.
    expect(row("server.handlerRuns.taskService:topic watch")).toMatchObject({
      first: 0,
      next: 50,
      presence: "new",
      worse: false,
    });
    expect(row("latency.taskService:updateTask.p50")).toMatchObject({ first: 3, next: 3 });
    expect(row("derived.bytesSentPerWriteKb")).toMatchObject({ first: 9.8, next: 2 });
  });

  it("puts every metric where the new version is worse at the top of the report", () => {
    const comparison = compare(before, newRun(40, 45), again);
    const markdown = renderComparison(comparison, SOURCES, "Profiles and follow-ups.");
    const worse = markdown.indexOf("## Where 5.0 is worse");
    expect(worse).toBeGreaterThan(0);
    expect(worse).toBeLessThan(markdown.indexOf("## Targets"));
    expect(markdown).toContain(
      "| board-steady | server cpuSeconds | 30 | 45 | 30 | 1.50× | 0.0% | worse |",
    );
    expect(markdown).toContain("## Analysis");
    expect(analysisOf(markdown)).toBe("Profiles and follow-ups.");
    expect(markdown).toContain("`a.json`, `b.json` and `c.json`");
    expect(markdown).toContain(
      "| board-steady bytes sent per write (KB) | 9.80 | 2 | at most 30% of 4.1 | met |",
    );
  });

  it("says so when nothing is worse and nothing is noisy", () => {
    const markdown = renderComparison(compare(before, newRun(40, 20), again), SOURCES, null);
    expect(markdown).toContain("Nowhere: on every metric");
    expect(markdown).toContain("Nothing: the two 4.1 runs agree within 10%");
    expect(analysisOf(markdown)).toBeNull();
    // A hand-written analysis survives rendering the report again.
    const written = markdown.replace(/Nothing written yet:[^\n]*/, "The profile says why.");
    const rendered = renderComparison(
      compare(before, newRun(40, 20), again),
      SOURCES,
      analysisOf(written),
    );
    expect(analysisOf(rendered)).toBe("The profile says why.");
  });
});
