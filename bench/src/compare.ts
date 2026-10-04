import type { BenchResult, Repetition, ScenarioResult } from "./result-schema";
import { median, round } from "./stats";

/**
 * A matched comparison (docs/benchmarks.md, rules 2 and 5): the old version,
 * the new one, then the old one again, from one sitting on one machine. Every
 * metric of every scenario gets the three medians, the new version's ratio to
 * the old runs' mean, how far the two old runs drifted apart, and whether the
 * new version is worse. `compare-report.ts` renders it.
 */

/** The two old runs differing by more than this share of their mean make a metric too noisy to compare. */
export const NOISE_LIMIT = 0.1;

/** Which way is better for a metric; `none` for counts of offered work and machine readings. */
export type Better = "lower" | "higher" | "none";

export interface MetricRow {
  /** The metric under one name for both versions (see `canonicalKey`). */
  key: string;
  /** Medians: the first old run, the new run, the second old run; null where a run lacks the metric. */
  first: number | null;
  next: number | null;
  second: number | null;
  /** The new median over the mean of the two old ones; null when either side is missing or the mean is 0. */
  ratio: number | null;
  /** |first - second| over their mean; null when either is missing or both are 0. */
  drift: number | null;
  better: Better;
  /** The two old runs differ by more than NOISE_LIMIT on this metric. */
  noisy: boolean;
  /** The new version is worse than both old runs on a metric where a direction is better. */
  worse: boolean;
  /**
   * `both` unless only one version has the thing measured at all (5.0's topic
   * watches, 4.1's unsubscribes on reconnect): then it is a difference in
   * design, shown but never judged worse or better.
   */
  presence: "both" | "old" | "new";
}

export interface ScenarioComparison {
  name: string;
  description: string;
  parameters: Record<string, number>;
  rows: MetricRow[];
}

export interface Comparison {
  before: BenchResult;
  after: BenchResult;
  again: BenchResult;
  scenarios: ScenarioComparison[];
}

/** One name per measured thing, whichever wire protocol named it. */
const EVENT_ALIASES: Record<string, string> = {
  batchSubscribe: "entity subscribe",
  unsubscribe: "entity unsubscribe",
  "collection:subscribe": "collection subscribe",
  "collection:unsubscribe": "collection unsubscribe",
  "qd:sub": "entity subscribe",
  "qd:unsub": "entity unsubscribe",
  "qd:col:sub": "collection subscribe",
  "qd:col:unsub": "collection unsubscribe",
  "qd:col:items": "collection items",
  "qd:watch": "topic watch",
  "qd:unwatch": "topic unwatch",
};

function canonicalEvent(event: string): string {
  const separator = event.indexOf(":");
  if (separator < 0) return event;
  const service = event.slice(0, separator);
  const name = event.slice(separator + 1);
  return `${service}:${EVENT_ALIASES[name] ?? name}`;
}

/**
 * A summary key with its event under one name for both protocols: 4.1's
 * `taskService:batchSubscribe` and 5.0's `taskService:qd:sub` are both
 * `taskService:entity subscribe`.
 */
export function canonicalKey(key: string): string {
  const parts = key.split(".");
  const [group, second] = parts;
  if ((group === "latency" || group === "requests") && second !== undefined && parts.length > 2) {
    return [group, canonicalEvent(second), ...parts.slice(2)].join(".");
  }
  if (group === "server" && second === "handlerRuns" && parts[2] !== undefined) {
    return ["server", "handlerRuns", canonicalEvent(parts.slice(2).join("."))].join(".");
  }
  return key;
}

const LOWER_SCENARIO_METRICS = new Set([
  "notRestoredWithinCap",
  "failedRestores",
  "failedRounds",
  "lastRestoreSeconds",
  "drainSeconds",
  "settleSeconds",
]);

/** Which way is better for `key`. */
export function betterFor(key: string): Better {
  const [group = "", second = ""] = key.split(".");
  const last = key.split(".").at(-1) ?? "";
  if (group === "latency" || group === "delivery" || group === "derived") return "lower";
  if (group === "requests") return last === "failed" ? "lower" : "none";
  if (group === "server") {
    if (second === "snapshots")
      return last === "collection" || last === "entity" ? "lower" : "none";
    return "lower";
  }
  if (group === "scenario") {
    if (last === "restored") return "higher";
    if (LOWER_SCENARIO_METRICS.has(last) || last.endsWith("Ms")) return "lower";
    return "none";
  }
  return "none";
}

/** Metrics computed per repetition from others: what one write or one round cost. */
function derived(rep: Repetition): Record<string, number | null> {
  const server = rep.server;
  const writes = rep.scenario.writesIssued;
  const out: Record<string, number | null> = {};
  if (server !== null && typeof writes === "number" && writes > 0) {
    out["derived.bytesSentPerWriteKb"] = round(server.bytesSent / 1024 / writes, 1);
    out["derived.sqlStatementsPerWrite"] = round(server.sqlStatements / writes, 2);
    out["derived.serverCpuMsPerWrite"] = round((server.cpuSeconds * 1_000) / writes, 2);
  }
  return out;
}

/** Every metric's median for one scenario, under canonical keys, with the derived ones. */
function mediansOf(scenario: ScenarioResult | undefined): Map<string, number | null> {
  const medians = new Map<string, number | null>();
  if (scenario === undefined) return medians;
  for (const [key, entry] of Object.entries(scenario.summary)) {
    medians.set(canonicalKey(key), entry.median);
  }
  const perRep = scenario.repetitions.map(derived);
  for (const key of new Set(perRep.flatMap((values) => Object.keys(values)))) {
    const value = median(perRep.map((values) => values[key] ?? null));
    medians.set(key, value === null ? null : round(value, 2));
  }
  return medians;
}

function ratioOf(next: number | null, base: number | null): number | null {
  if (next === null || base === null || base === 0) return null;
  return round(next / base, 3);
}

/** Builds one row from the three runs' medians of a metric. */
export function rowOf(
  key: string,
  first: number | null,
  next: number | null,
  second: number | null,
  presence: MetricRow["presence"] = "both",
): MetricRow {
  const base = first !== null && second !== null ? (first + second) / 2 : null;
  const drift =
    first !== null && second !== null && base !== null && base !== 0
      ? round(Math.abs(first - second) / Math.abs(base), 3)
      : null;
  const better = presence === "both" ? betterFor(key) : "none";
  const worse =
    next !== null &&
    first !== null &&
    second !== null &&
    ((better === "lower" && next > Math.max(first, second)) ||
      (better === "higher" && next < Math.min(first, second)));
  return {
    key,
    first,
    next,
    second,
    ratio: ratioOf(next, base),
    drift,
    better,
    noisy: drift !== null && drift > NOISE_LIMIT,
    worse,
    presence,
  };
}

/** Group order in a scenario's table, then keys alphabetically. */
const GROUP_ORDER = [
  "scenario",
  "latency",
  "delivery",
  "requests",
  "server",
  "derived",
  "loadgen",
  "noise",
];

function sortKeys(keys: Iterable<string>): string[] {
  const rank = (key: string): number => {
    const index = GROUP_ORDER.indexOf(key.split(".")[0] ?? "");
    return index < 0 ? GROUP_ORDER.length : index;
  };
  return [...keys].sort((a, b) => rank(a) - rank(b) || a.localeCompare(b));
}

/**
 * Counts a run reports only once they happen: a version that never sent an
 * event (5.0 sends no unsubscribes on a reconnect; 4.1 never watches a topic)
 * counted zero of it, rather than not measuring it.
 */
function isCount(key: string): boolean {
  return (
    key.startsWith("server.handlerRuns.") ||
    key.startsWith("server.snapshots.") ||
    /^requests\..+\.(sent|failed|abandoned)$/.test(key)
  );
}

function compareScenario(
  name: string,
  before: BenchResult,
  after: BenchResult,
  again: BenchResult,
): ScenarioComparison {
  const find = (result: BenchResult): ScenarioResult | undefined =>
    result.scenarios.find((scenario) => scenario.name === name);
  const first = mediansOf(find(before));
  const next = mediansOf(find(after));
  const second = mediansOf(find(again));
  const keys = sortKeys(new Set([...first.keys(), ...next.keys(), ...second.keys()]));
  const value = (medians: Map<string, number | null>, key: string): number | null => {
    const known = medians.get(key);
    if (known !== undefined) return known;
    return isCount(key) && medians.has("server.cpuSeconds") ? 0 : null;
  };
  const presence = (key: string): MetricRow["presence"] => {
    const old = first.has(key) || second.has(key);
    if (old === next.has(key)) return "both";
    return old ? "old" : "new";
  };
  const reference = find(before) ?? find(after);
  return {
    name,
    description: reference?.description ?? "",
    parameters: reference?.parameters ?? {},
    rows: keys.map((key) =>
      rowOf(key, value(first, key), value(next, key), value(second, key), presence(key)),
    ),
  };
}

function sameJson(a: unknown, b: unknown): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}

/**
 * Why the three results may not be compared (docs/benchmarks.md, rule 5):
 * every difference in workload, scenario parameters, repetitions, CPU
 * limits, machine or runtime versions. Empty when they match.
 */
export function mismatches(before: BenchResult, after: BenchResult, again: BenchResult): string[] {
  const problems: string[] = [];
  const runs = { "the first old run": before, "the new run": after, "the second old run": again };
  for (const [name, run] of Object.entries(runs)) {
    if (run.quick) problems.push(`${name} is a --quick run`);
  }
  const checks: Array<[string, (result: BenchResult) => unknown]> = [
    ["workload", (result) => result.workload],
    [
      "machine",
      ({ machine }) => [machine.hostname, machine.cpuModel, machine.nproc, machine.kernel],
    ],
    ["CPU frequency settings", ({ machine }) => [machine.cpuGovernor, machine.cpuBoost]],
    [
      "CPU limits",
      ({ limits }) => [
        limits.server.cpus,
        limits.server.method,
        limits.loadgen.cpus,
        limits.postgres.cpus,
      ],
    ],
    ["runtime versions", ({ runtime }) => [runtime.node, runtime.postgres, runtime.socketIoClient]],
    [
      "scenarios",
      (result) =>
        result.scenarios.map((scenario) => [
          scenario.name,
          scenario.parameters,
          scenario.repetitions.length,
        ]),
    ],
  ];
  for (const [what, pick] of checks) {
    if (!sameJson(pick(before), pick(after)) || !sameJson(pick(before), pick(again))) {
      problems.push(`the ${what} differ between the runs`);
    }
  }
  return problems;
}

/** Compares a new version's run with the old version's runs before and after it. */
export function compare(before: BenchResult, after: BenchResult, again: BenchResult): Comparison {
  const problems = mismatches(before, after, again);
  if (problems.length > 0) {
    throw new Error(`these runs cannot be compared: ${problems.join("; ")}`);
  }
  const names = before.scenarios.map((scenario) => scenario.name);
  return {
    before,
    after,
    again,
    scenarios: names.map((name) => compareScenario(name, before, after, again)),
  };
}
