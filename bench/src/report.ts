import { mkdir, writeFile } from "node:fs/promises";
import { dirname, relative } from "node:path";
import { SCHEMA_FILE } from "./paths";
import { resultSchema, type BenchResult, type ScenarioResult } from "./result-schema";
import { median, round } from "./stats";

/**
 * Write a run's result: the JSON file (validated against the result schema)
 * and a Markdown report a reviewer can read without opening the JSON.
 */

const GROUPS = ["scenario.", "latency.", "delivery.", "requests.", "server.", "loadgen."];

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

function renderLoad(result: BenchResult): string {
  const loads = result.scenarios.flatMap((s) => s.repetitions.map((r) => r.loadAverage.one));
  const low = Math.min(...loads);
  const high = Math.max(...loads);
  return (
    `The 1-minute load average at the start of the ${loads.length} runs was between ` +
    `${low.toFixed(2)} and ${high.toFixed(2)} (median ${formatNumber(median(loads))}) on a ` +
    `${result.machine.nproc}-CPU machine. The pinned cores were not reserved for the benchmark: ` +
    "other processes on the machine could still be scheduled on them."
  );
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
