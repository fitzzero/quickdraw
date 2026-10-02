import { mkdir, writeFile } from "node:fs/promises";
import { dirname, relative } from "node:path";
import { SCHEMA_FILE } from "./paths";
import {
  resultSchema,
  type BenchResult,
  type Repetition,
  type ScenarioResult,
} from "./result-schema";
import { median, round } from "./stats";

/**
 * Write a run's result: the JSON file (validated against the result schema)
 * and a Markdown report a reviewer can read without opening the JSON.
 */

const GROUPS = ["scenario.", "latency.", "delivery.", "requests.", "server.", "loadgen.", "noise."];

const NOISE_LABELS: Record<string, string> = {
  otherWorkOnServerCpusPct: "other work on the server cpus (%)",
  restOfMachineBusyPct: "rest of the machine busy (%)",
};

function shortEvent(event: string): string {
  return event.replace(/^taskService:/, "");
}

export function metricLabel(key: string): string {
  const parts = key.split(".");
  const [group = "", ...rest] = parts;
  switch (group) {
    case "latency":
      return `${shortEvent(rest[0] ?? "")} ${rest[1] ?? ""} (ms)`;
    case "delivery":
      return `${rest[0] ?? ""} delivery ${rest[1] ?? ""} (ms)`;
    case "requests":
      return rest.length === 1
        ? "failed requests, all calls"
        : `${shortEvent(rest[0] ?? "")} ${rest[1] ?? ""}`;
    case "loadgen":
      return `load generator ${rest.join(" ")}`;
    case "noise":
      return NOISE_LABELS[rest[0] ?? ""] ?? rest.join(" ");
    case "scenario":
      return rest.join(".");
    default:
      return `${group} ${rest.map(shortEvent).join(" ")}`;
  }
}

export function formatNumber(value: number | null): string {
  if (value === null) return "n/a";
  if (Number.isInteger(value)) return value.toLocaleString("en-US");
  const magnitude = Math.abs(value);
  return value.toFixed(magnitude >= 100 ? 0 : magnitude >= 10 ? 1 : 2);
}

function orderedKeys(summary: ScenarioResult["summary"]): string[] {
  const keys = Object.keys(summary);
  return GROUPS.flatMap((prefix) => keys.filter((key) => key.startsWith(prefix)).sort());
}

function renderScenario(scenario: ScenarioResult): string {
  const lines = [`### ${scenario.name}`, "", scenario.description, ""];
  const parameters = Object.entries(scenario.parameters)
    .map(([name, value]) => `${name} ${formatNumber(value)}`)
    .join(", ");
  lines.push(`Parameters: ${parameters}.`, "", "Repetitions:", "");
  for (const rep of scenario.repetitions) {
    const load = rep.loadAverage.one.toFixed(2);
    lines.push(
      `${rep.index}. ${rep.completed ? "Completed" : "Did not complete"}: ${rep.outcome} (load ${load} at start).`,
    );
    if (rep.serverError) lines.push(`   Server metrics not measured: ${rep.serverError}`);
    for (const error of rep.errors) lines.push(`   Error seen: \`${error}\``);
  }
  lines.push("", "| Metric | Median | Min | Max | Spread |", "| --- | ---: | ---: | ---: | ---: |");
  for (const key of orderedKeys(scenario.summary)) {
    const entry = scenario.summary[key];
    if (!entry) continue;
    const spread = entry.spreadPct === null ? "n/a" : `${formatNumber(entry.spreadPct)}%`;
    lines.push(
      `| ${metricLabel(key)} | ${formatNumber(entry.median)} | ${formatNumber(entry.min)} | ${formatNumber(entry.max)} | ${spread} |`,
    );
  }
  return lines.join("\n");
}

function renderSetup(result: BenchResult): string {
  const { machine, runtime, limits, app } = result;
  const versions = Object.entries(app.versions)
    .map(([name, version]) => `${name} ${version}`)
    .join(", ");
  const rows: Array<[string, string]> = [
    ["Machine", `${machine.cpuModel}, nproc ${machine.nproc}, ${machine.totalMemoryGb} GB RAM`],
    ["OS and kernel", `${machine.os}, Linux ${machine.kernel}`],
    [
      "CPU frequency",
      `governor ${machine.cpuGovernor ?? "unknown"}, boost ${machine.cpuBoost ?? "unknown"}`,
    ],
    ["Server CPU limit", limits.server.detail],
    ["Load generator", limits.loadgen.detail],
    ["Postgres", `${limits.postgres.detail}; Postgres ${runtime.postgres ?? "unknown"}`],
    [
      "Runtimes",
      `Node ${runtime.node}, bun ${runtime.bun ?? "unknown"}, Docker ${runtime.docker ?? "unknown"}`,
    ],
    ["App", `${versions}; pg pool ${app.dbPoolMax}; ${app.logging}`],
    [
      "Client",
      `socket.io-client ${runtime.socketIoClient ?? "unknown"} (one connection per simulated client)`,
    ],
    [
      "Workload",
      Object.entries(result.workload)
        .map(([k, v]) => `${k} ${v}`)
        .join(", "),
    ],
  ];
  return ["| | |", "| --- | --- |", ...rows.map(([name, value]) => `| ${name} | ${value} |`)].join(
    "\n",
  );
}

function percent(value: number): string {
  return `${value.toFixed(1)}%`;
}

function spanOf(values: number[], format: (value: number) => string): string {
  if (values.length === 0) return "not measured";
  const mid = median(values) ?? 0;
  return `${format(Math.min(...values))} to ${format(Math.max(...values))} (median ${format(mid)})`;
}

function renderLoad(result: BenchResult): string {
  const byRun = new Map<string, Repetition>(
    result.scenarios.flatMap((s) => s.repetitions.map((r) => [`${s.name}#${r.index}`, r] as const)),
  );
  const runs = result.order.flatMap((key) => {
    const rep = byRun.get(key);
    return rep ? [{ key, rep }] : [];
  });
  const other = runs.flatMap(({ rep }) => (rep.noise ? [rep.noise.otherWorkOnServerCpusPct] : []));
  const rest = runs.flatMap(({ rep }) => (rep.noise ? [rep.noise.restOfMachineBusyPct] : []));
  const loads = runs.map(({ rep }) => rep.loadAverage.one);
  const { limits } = result;
  const restCpus =
    result.machine.nproc -
    limits.server.cpuCount -
    limits.loadgen.cpuCount -
    limits.postgres.cpuCount;
  const summary =
    `During the measured windows, other processes used ${spanOf(other, percent)} of the ` +
    `${limits.server.cpuCount} cpus the server was pinned to, and the ${restCpus} cpus the ` +
    `benchmark did not use were ${spanOf(rest, percent)} busy. The 1-minute load average at the ` +
    `start of each run was ${spanOf(loads, (v) => v.toFixed(2))}; it includes the benchmark's ` +
    "own previous run. Nothing reserved the pinned cpus for the benchmark.";
  const rows = runs.map(({ key, rep }) => {
    const noise = rep.noise;
    return (
      `| ${key} | ${rep.startedAt.slice(11, 19)} | ${rep.loadAverage.one.toFixed(2)} | ` +
      `${noise ? percent(noise.otherWorkOnServerCpusPct) : "n/a"} | ` +
      `${noise ? percent(noise.restOfMachineBusyPct) : "n/a"} |`
    );
  });
  return [
    summary,
    "",
    "| Run | Started (UTC) | Load average, 1 min | Other work on server cpus | Rest of machine busy |",
    "| --- | --- | ---: | ---: | ---: |",
    ...rows,
  ].join("\n");
}

export function renderMarkdown(result: BenchResult, jsonName: string): string {
  const title =
    result.kind === "baseline"
      ? `# quickdraw-core ${result.label} benchmark baseline`
      : `# quickdraw-core ${result.label} benchmark run`;
  const minutes = (result.totalDurationMs / 60_000).toFixed(1);
  const repetitions = Math.max(...result.scenarios.map((s) => s.repetitions.length));
  const sections = [
    title,
    `Recorded ${result.createdAt} on \`${result.machine.hostname}\` with \`${result.command}\` (${minutes} min). ` +
      (repetitions === 1
        ? "Each scenario ran once, so there is no spread to read."
        : `Every number is the median of ${repetitions} repetitions.`) +
      ` The full data is in \`${jsonName}\`; the measurement rules are in docs/benchmarks.md.`,
    "## Setup",
    renderSetup(result),
    "## Machine load",
    renderLoad(result),
    "## Results",
    ...result.scenarios.map(renderScenario),
    "## Notes",
    result.notes.map((note) => `- ${note}`).join("\n"),
    "## Not measured",
    result.notMeasured.length > 0
      ? result.notMeasured.map((note) => `- ${note}`).join("\n")
      : "Nothing.",
  ];
  return `${sections.join("\n\n")}\n`;
}

/** JSON with fractional numbers cut to three decimals (microseconds for millisecond values). */
function toJson(value: unknown): string {
  const replacer = (_key: string, item: unknown): unknown =>
    typeof item === "number" && !Number.isInteger(item) ? round(item, 3) : item;
  return `${JSON.stringify(value, replacer, 2)}\n`;
}

/** Validate and write the JSON result plus its Markdown report. */
export async function writeResult(
  result: BenchResult,
  jsonPath: string,
  markdownPath: string,
): Promise<void> {
  const withSchema = { $schema: relative(dirname(jsonPath), SCHEMA_FILE), ...result };
  const parsed = resultSchema.safeParse(withSchema);
  await mkdir(dirname(jsonPath), { recursive: true });
  await mkdir(dirname(markdownPath), { recursive: true });
  if (!parsed.success) {
    await writeFile(`${jsonPath}.invalid`, toJson(withSchema));
    throw new Error(`result does not match the schema: ${parsed.error.message}`);
  }
  await writeFile(jsonPath, toJson(withSchema));
  await writeFile(markdownPath, renderMarkdown(result, relative(dirname(markdownPath), jsonPath)));
}
