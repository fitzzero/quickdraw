import type { Comparison, MetricRow, ScenarioComparison } from "./compare";
import { formatNumber, metricLabel } from "./report";
import type { BenchResult } from "./result-schema";
import { median, round } from "./stats";

/**
 * The Markdown report of a matched comparison (`compare.ts`): where the new
 * version is worse first, then what was too noisy to compare, the targets,
 * the analysis written for this comparison, and every metric of every
 * scenario with the three runs side by side.
 */

/** Where the report's inputs live, for its header. */
export interface ComparisonSources {
  before: string;
  after: string;
  again: string;
}

const DERIVED_LABELS: Record<string, string> = {
  "derived.bytesSentPerWriteKb": "sent per write (KB)",
  "derived.sqlStatementsPerWrite": "SQL statements per write",
  "derived.serverCpuMsPerWrite": "server CPU per write (ms)",
};

function label(key: string): string {
  return DERIVED_LABELS[key] ?? metricLabel(key);
}

function percent(share: number | null): string {
  return share === null ? "n/a" : `${(share * 100).toFixed(share >= 1 ? 0 : 1)}%`;
}

function ratioText(ratio: number | null): string {
  return ratio === null ? "n/a" : `${ratio.toFixed(ratio >= 10 ? 1 : 2)}×`;
}

function versionOf(result: BenchResult): string {
  return result.label === result.app.quickdrawCore
    ? result.label
    : `${result.label} (installed ${result.app.quickdrawCore})`;
}

interface Goal {
  readonly name: string;
  readonly scenario: string;
  readonly goal: string;
  /** The old runs' mean and the new value of what the goal is about, and whether it is met. */
  evaluate(scenario: ScenarioComparison): {
    old: number | null;
    next: number | null;
    met: boolean | null;
  };
}

function rowIn(scenario: ScenarioComparison, key: string): MetricRow | undefined {
  return scenario.rows.find((row) => row.key === key);
}

function mean(row: MetricRow | undefined): number | null {
  return row?.first === null || row?.second === null || row === undefined
    ? null
    : (row.first + row.second) / 2;
}

/** A goal on one metric: the new value at most `share` of the old runs' mean. */
function shareGoal(name: string, scenario: string, key: string, share: number): Goal {
  return {
    name,
    scenario,
    goal: `at most ${Math.round(share * 100)}% of 4.1`,
    evaluate: (comparison) => {
      const row = rowIn(comparison, key);
      const old = mean(row);
      const next = row?.next ?? null;
      return { old, next, met: old === null || next === null ? null : next <= old * share };
    },
  };
}

/** The targets the 5.0 benchmark card set: reported against, never gates. */
export const GOALS: readonly Goal[] = [
  shareGoal(
    "board-steady board query p95 (ms)",
    "board-steady",
    "latency.taskService:getTasksByStatus.p95",
    0.5,
  ),
  shareGoal(
    "board-steady bytes sent per write (KB)",
    "board-steady",
    "derived.bytesSentPerWriteKb",
    0.3,
  ),
  {
    name: "reconnect-storm snapshots served (collection pages + entity rows)",
    scenario: "reconnect-storm",
    goal: "at most 10% of 4.1",
    evaluate: (comparison) => {
      const sum = (pick: (row: MetricRow) => number | null): number | null => {
        const values = ["server.snapshots.collection", "server.snapshots.entity"].map((key) => {
          const row = rowIn(comparison, key);
          return row === undefined ? null : pick(row);
        });
        return values.some((value) => value === null)
          ? null
          : values.reduce<number>((total, value) => total + (value ?? 0), 0);
      };
      const first = sum((row) => row.first);
      const second = sum((row) => row.second);
      const old = first === null || second === null ? null : (first + second) / 2;
      const next = sum((row) => row.next);
      return { old, next, met: old === null || next === null ? null : next <= old * 0.1 };
    },
  },
  {
    name: "fat-read board query handler runs per round",
    scenario: "fat-read",
    goal: "1 per round",
    evaluate: (comparison) => {
      const rounds = comparison.parameters.rounds ?? 0;
      const row = rowIn(comparison, "server.handlerRuns.taskService:getTasksByStatus");
      const perRound = (value: number | null): number | null =>
        value === null || rounds === 0 ? null : round(value / rounds, 2);
      const old = perRound(mean(row));
      const next = perRound(row?.next ?? null);
      return { old, next, met: next === null ? null : next <= 1 };
    },
  },
];

function goalsTable(comparison: Comparison): string {
  const lines = [
    "| Target | 4.1 (mean of both runs) | 5.0 | Goal | Result |",
    "| --- | ---: | ---: | --- | --- |",
  ];
  for (const goal of GOALS) {
    const scenario = comparison.scenarios.find((entry) => entry.name === goal.scenario);
    const result =
      scenario === undefined ? { old: null, next: null, met: null } : goal.evaluate(scenario);
    const verdict = result.met === null ? "not measured" : result.met ? "met" : "**missed**";
    lines.push(
      `| ${goal.name} | ${formatNumber(result.old)} | ${formatNumber(result.next)} | ${goal.goal} | ${verdict} |`,
    );
  }
  return lines.join("\n");
}

function listenersTable(comparison: Comparison): string {
  const lines = ["| Scenario | 4.1 first | 5.0 | 4.1 second |", "| --- | ---: | ---: | ---: |"];
  for (const scenario of comparison.scenarios) {
    const row = rowIn(scenario, "server.listenersPerSocket");
    lines.push(
      `| ${scenario.name} | ${formatNumber(row?.first ?? null)} | ${formatNumber(row?.next ?? null)} | ${formatNumber(row?.second ?? null)} |`,
    );
  }
  return lines.join("\n");
}

const PRESENCE_FLAGS: Record<MetricRow["presence"], string> = {
  both: "",
  old: "4.1 only",
  new: "5.0 only",
};

function metricLine(scenario: string | null, row: MetricRow): string {
  const flags = [row.worse ? "worse" : "", row.noisy ? "noisy" : "", PRESENCE_FLAGS[row.presence]]
    .filter(Boolean)
    .join(", ");
  const lead = scenario === null ? "" : `${scenario} | `;
  return (
    `| ${lead}${label(row.key)} | ${formatNumber(row.first)} | ${formatNumber(row.next)} | ` +
    `${formatNumber(row.second)} | ${ratioText(row.ratio)} | ${percent(row.drift)} | ${flags} |`
  );
}

function worseSection(comparison: Comparison): string {
  const rows = comparison.scenarios.flatMap((scenario) =>
    scenario.rows.filter((row) => row.worse).map((row) => ({ scenario: scenario.name, row })),
  );
  if (rows.length === 0) {
    return "Nowhere: on every metric where a direction is better, 5.0 is at least as good as one of the two 4.1 runs.";
  }
  rows.sort((a, b) => (b.row.ratio ?? 0) - (a.row.ratio ?? 0));
  return [
    `Every metric where 5.0 is worse than both 4.1 runs (${rows.length}), the largest ratio first. ` +
      "A metric marked noisy is one the two 4.1 runs themselves disagree on by more than 10%.",
    "",
    "| Scenario | Metric | 4.1 first | 5.0 | 4.1 second | 5.0 / 4.1 | 4.1 drift | |",
    "| --- | --- | ---: | ---: | ---: | ---: | ---: | --- |",
    ...rows.map(({ scenario, row }) => metricLine(scenario, row)),
  ].join("\n");
}

function noisySection(comparison: Comparison): string {
  const rows = comparison.scenarios.flatMap((scenario) =>
    scenario.rows
      .filter((row) => row.noisy && row.better !== "none")
      .map((row) => ({ scenario: scenario.name, row })),
  );
  if (rows.length === 0) {
    return "Nothing: the two 4.1 runs agree within 10% on every metric where a direction is better.";
  }
  return [
    `The two 4.1 runs differ by more than 10% on these metrics (${rows.length}), so the environment was too noisy to compare them; their ratios are shown but prove nothing.`,
    "",
    "| Scenario | Metric | 4.1 first | 5.0 | 4.1 second | 5.0 / 4.1 | 4.1 drift | |",
    "| --- | --- | ---: | ---: | ---: | ---: | ---: | --- |",
    ...rows.map(({ scenario, row }) => metricLine(scenario, row)),
  ].join("\n");
}

const HEADLINES = [
  "requests.failed",
  "server.cpuSeconds",
  "server.eventLoopDelayP99Ms",
  "server.bytesSentMb",
  "server.sqlStatements",
];

function summarySection(comparison: Comparison): string {
  const lines = [
    "| Scenario | Metric | 4.1 first | 5.0 | 4.1 second | 5.0 / 4.1 | 4.1 drift | |",
    "| --- | --- | ---: | ---: | ---: | ---: | ---: | --- |",
  ];
  for (const scenario of comparison.scenarios) {
    const p95 = scenario.rows.filter(
      (row) => row.key.startsWith("latency.") && row.key.endsWith(".p95"),
    );
    const headline = HEADLINES.flatMap((key) => {
      const row = rowIn(scenario, key);
      return row === undefined ? [] : [row];
    });
    for (const row of [...p95, ...headline]) lines.push(metricLine(scenario.name, row));
  }
  return lines.join("\n");
}

function setupSection(comparison: Comparison): string {
  const { before, after } = comparison;
  const { machine, runtime, limits } = before;
  const app = (result: BenchResult): string =>
    `${Object.entries(result.app.versions)
      .map(([name, version]) => `${name} ${version}`)
      .join(", ")}; pg pool ${result.app.dbPoolMax}; ${result.app.logging}`;
  const rows: Array<[string, string]> = [
    [
      "Machine",
      `\`${machine.hostname}\`: ${machine.cpuModel}, nproc ${machine.nproc}, ${machine.totalMemoryGb} GB RAM`,
    ],
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
      `Node ${runtime.node}, bun ${runtime.bun ?? "unknown"}, Docker ${runtime.docker ?? "unknown"}, socket.io-client ${runtime.socketIoClient ?? "unknown"}`,
    ],
    [`4.1 app (\`bench/apps/${before.app.name}\`)`, app(before)],
    [`5.0 app (\`bench/apps/${after.app.name}\`)`, app(after)],
    [
      "Workload",
      Object.entries(before.workload)
        .map(([k, v]) => `${k} ${v}`)
        .join(", "),
    ],
  ];
  return ["| | |", "| --- | --- |", ...rows.map(([name, value]) => `| ${name} | ${value} |`)].join(
    "\n",
  );
}

function spanOf(values: number[], digits: number, unit: string): string {
  if (values.length === 0) return "not measured";
  return `${Math.min(...values).toFixed(digits)}${unit} to ${Math.max(...values).toFixed(digits)}${unit} (median ${(median(values) ?? 0).toFixed(digits)}${unit})`;
}

function loadSection(comparison: Comparison): string {
  const runs: Array<[string, BenchResult]> = [
    ["4.1 first", comparison.before],
    ["5.0", comparison.after],
    ["4.1 second", comparison.again],
  ];
  const lines = [
    "| Run | Started (UTC) | Minutes | Load average at each start, 1 min | Other work on the server cpus | Rest of the machine busy |",
    "| --- | --- | ---: | --- | --- | --- |",
  ];
  for (const [name, result] of runs) {
    const reps = result.scenarios.flatMap((scenario) => scenario.repetitions);
    const loads = reps.map((rep) => rep.loadAverage.one);
    const other = reps.flatMap((rep) => (rep.noise ? [rep.noise.otherWorkOnServerCpusPct] : []));
    const rest = reps.flatMap((rep) => (rep.noise ? [rep.noise.restOfMachineBusyPct] : []));
    lines.push(
      `| ${name} | ${result.createdAt.slice(11, 19)} | ${(result.totalDurationMs / 60_000).toFixed(1)} | ` +
        `${spanOf(loads, 2, "")} | ${spanOf(other, 1, "%")} | ${spanOf(rest, 1, "%")} |`,
    );
  }
  return [
    "Nothing reserved the pinned cpus for the benchmark; other work on the machine shows in these columns. The load average includes the benchmark's own previous run.",
    "",
    ...lines,
  ].join("\n");
}

function outcomesOf(name: string, result: BenchResult, scenario: string): string[] {
  const reps = result.scenarios.find((entry) => entry.name === scenario)?.repetitions ?? [];
  return reps.map(
    (rep) =>
      `- ${name}, repetition ${rep.index}: ${rep.completed ? "completed" : "**did not complete**"}: ${rep.outcome}` +
      (rep.serverError === null ? "" : `; server metrics not measured: ${rep.serverError}`) +
      (rep.errors.length === 0
        ? ""
        : `; errors seen: ${rep.errors.map((error) => `\`${error}\``).join(", ")}`),
  );
}

function scenarioSection(comparison: Comparison, scenario: ScenarioComparison): string {
  const parameters = Object.entries(scenario.parameters)
    .map(([name, value]) => `${name} ${formatNumber(value)}`)
    .join(", ");
  return [
    `### ${scenario.name}`,
    "",
    scenario.description,
    "",
    `Parameters: ${parameters}.`,
    "",
    ...outcomesOf("4.1 first", comparison.before, scenario.name),
    ...outcomesOf("5.0", comparison.after, scenario.name),
    ...outcomesOf("4.1 second", comparison.again, scenario.name),
    "",
    "| Metric | 4.1 first | 5.0 | 4.1 second | 5.0 / 4.1 | 4.1 drift | |",
    "| --- | ---: | ---: | ---: | ---: | ---: | --- |",
    ...scenario.rows.map((row) => metricLine(null, row)),
  ].join("\n");
}

function notesSection(comparison: Comparison): string {
  const notes = [...new Set([...comparison.before.notes, ...comparison.after.notes])];
  return [
    "- Medians of every scenario's repetitions, per run. `5.0 / 4.1` divides the 5.0 median by the mean of the two 4.1 medians; `4.1 drift` is how far the two 4.1 medians differ, as a share of their mean. A metric is marked worse when 5.0 is worse than both 4.1 runs, and noisy when the 4.1 drift is above 10%.",
    "- 4.1 and 5.0 name some things differently on the wire; rows use one name for both: entity subscribe is 4.1's batchSubscribe and 5.0's qd:sub, collection subscribe is collection:subscribe and qd:col:sub, entity and collection unsubscribe likewise; topic watch (qd:watch) exists only in 5.0. A count of something only one version does (requests sent, handler runs, snapshots) shows 0 for the other and is marked `4.1 only` or `5.0 only`: a difference in design, never judged worse; any other metric a version does not have shows n/a.",
    "- Per-write rows divide each repetition's bytes sent, SQL statements and server CPU by the writes it issued, then take the median.",
    ...notes.map((note) => `- ${note}`),
  ].join("\n");
}

function notMeasuredSection(comparison: Comparison): string {
  const notes = [
    ...comparison.before.notMeasured.map((note) => `4.1 first: ${note}`),
    ...comparison.after.notMeasured.map((note) => `5.0: ${note}`),
    ...comparison.again.notMeasured.map((note) => `4.1 second: ${note}`),
  ];
  return notes.length === 0 ? "Nothing." : notes.map((note) => `- ${note}`).join("\n");
}

/** The report, with `analysis` (Markdown written for this comparison) under its own heading. */
export function renderComparison(
  comparison: Comparison,
  sources: ComparisonSources,
  analysis: string | null,
): string {
  const { before, after, again } = comparison;
  const reps = Math.max(...after.scenarios.map((scenario) => scenario.repetitions.length));
  const sections = [
    `# quickdraw-core ${after.label} against ${before.label}`,
    `Measured on \`${before.machine.hostname}\` in one sitting, ${before.createdAt.slice(0, 16)}Z to ${again.createdAt.slice(0, 16)}Z: ` +
      `${versionOf(before)}, then ${versionOf(after)}, then ${versionOf(again)} again, every scenario ${reps} times per run ` +
      "(interleaved), medians reported. The three result files are " +
      `\`${sources.before}\`, \`${sources.after}\` and \`${sources.again}\`; the measurement rules are in docs/benchmarks.md.`,
    "## Where 5.0 is worse",
    worseSection(comparison),
    "## Too noisy to compare",
    noisySection(comparison),
    "## Targets",
    goalsTable(comparison),
    "Listeners per connected socket when each window closed:",
    listenersTable(comparison),
    ...(analysis === null ? [] : ["## Analysis", analysis.trim()]),
    "## Summary",
    summarySection(comparison),
    "## Setup",
    setupSection(comparison),
    "## Machine load",
    loadSection(comparison),
    "## Results",
    ...comparison.scenarios.map((scenario) => scenarioSection(comparison, scenario)),
    "## Notes",
    notesSection(comparison),
    "## Not measured",
    notMeasuredSection(comparison),
  ];
  return `${sections.join("\n\n")}\n`;
}
