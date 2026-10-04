import { parseArgs } from "node:util";
import { TARGETS, type Target } from "./drivers/types";
import { SCENARIO_NAMES, type ScenarioName } from "./scenarios";

export interface Options {
  scenarios: ScenarioName[];
  repetitions: number;
  quick: boolean;
  baseline: boolean;
  /** The app under bench/apps/ and the driver that speaks its protocol. */
  target: Target;
  /** What the results are filed under; default: the quickdraw-core version the app installs. */
  label: string | null;
  /** Write a V8 CPU profile of the server process per repetition. */
  cpuProf: boolean;
  serverCpus: string;
  loadgenCpus: string;
  pgCpus: string;
  port: number;
  pgPort: number;
  keepDb: boolean;
  args: string[];
}

export const USAGE = `Usage: bun run --filter bench bench -- [options]

  --target <name>       ${TARGETS.join(" or ")}: the app under bench/apps/ and its client (default v4)
  --scenario <name>     ${SCENARIO_NAMES.join(", ")} or all (repeatable, default all)
  --repetitions <n>     repetitions per scenario (default 3, or 1 with --quick)
  --quick               small, short smoke run (10 s, 10 viewers for board-steady)
  --baseline            write baselines/<label>.json and reports/<label>.md
  --label <name>        file the results under this name (default: the app's quickdraw-core version)
  --cpu-prof            write a CPU profile of the server per repetition (results/logs/<run>/profiles)
  --server-cpus <list>  cpus the server is pinned to (default 2,3)
  --loadgen-cpus <list> cpus the load generator is pinned to (default 10,11)
  --pg-cpus <list>      cpuset for the Postgres container (default 6-9)
  --port <n>            server port (default 4090)
  --pg-port <n>         Postgres host port (default 5544)
  --keep-db             leave the Postgres container running afterwards
  --app <name>          the same as --target
`;

function positiveInt(value: string, name: string): number {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed <= 0)
    throw new Error(`${name} must be a positive integer`);
  return parsed;
}

function scenarioList(values: string[]): ScenarioName[] {
  const names = values.flatMap((value) => value.split(",")).map((value) => value.trim());
  if (names.length === 0 || names.includes("all")) return [...SCENARIO_NAMES];
  for (const name of names) {
    if (!(SCENARIO_NAMES as readonly string[]).includes(name)) {
      throw new Error(`unknown scenario "${name}"; expected one of ${SCENARIO_NAMES.join(", ")}`);
    }
  }
  return names as ScenarioName[];
}

function targetOf(target: string | undefined, app: string | undefined): Target {
  if (target !== undefined && app !== undefined && target !== app) {
    throw new Error(`--target ${target} and --app ${app} disagree; pass one of them`);
  }
  const name = target ?? app ?? "v4";
  if (!(TARGETS as readonly string[]).includes(name)) {
    throw new Error(`unknown target "${name}"; expected one of ${TARGETS.join(", ")}`);
  }
  return name as Target;
}

function labelOf(label: string | undefined): string | null {
  if (label === undefined) return null;
  if (!/^[\w.-]+$/.test(label)) {
    throw new Error("--label may hold only letters, digits, '.', '_' and '-'");
  }
  return label;
}

export function parseOptions(argv: string[]): Options {
  const args = argv.filter((arg) => arg !== "--");
  const { values } = parseArgs({
    args,
    strict: true,
    options: {
      scenario: { type: "string", multiple: true, default: [] },
      repetitions: { type: "string" },
      quick: { type: "boolean", default: false },
      baseline: { type: "boolean", default: false },
      target: { type: "string" },
      app: { type: "string" },
      label: { type: "string" },
      "cpu-prof": { type: "boolean", default: false },
      "server-cpus": { type: "string", default: "2,3" },
      "loadgen-cpus": { type: "string", default: "10,11" },
      "pg-cpus": { type: "string", default: "6-9" },
      port: { type: "string", default: "4090" },
      "pg-port": { type: "string", default: "5544" },
      "keep-db": { type: "boolean", default: false },
    },
  });
  const quick = values.quick;
  return {
    scenarios: scenarioList(values.scenario),
    repetitions: positiveInt(values.repetitions ?? (quick ? "1" : "3"), "--repetitions"),
    quick,
    baseline: values.baseline,
    target: targetOf(values.target, values.app),
    label: labelOf(values.label),
    cpuProf: values["cpu-prof"],
    serverCpus: values["server-cpus"],
    loadgenCpus: values["loadgen-cpus"],
    pgCpus: values["pg-cpus"],
    port: positiveInt(values.port, "--port"),
    pgPort: positiveInt(values["pg-port"], "--pg-port"),
    keepDb: values["keep-db"],
    args,
  };
}
