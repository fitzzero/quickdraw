import { parseArgs } from "node:util";
import { SCENARIO_NAMES, type ScenarioName } from "./scenarios";

export interface Options {
  scenarios: ScenarioName[];
  repetitions: number;
  quick: boolean;
  baseline: boolean;
  app: string;
  serverCpus: string;
  loadgenCpus: string;
  pgCpus: string;
  port: number;
  pgPort: number;
  keepDb: boolean;
  args: string[];
}

export const USAGE = `Usage: bun run --filter bench bench -- [options]

  --scenario <name>     ${SCENARIO_NAMES.join(", ")} or all (repeatable, default all)
  --repetitions <n>     repetitions per scenario (default 3, or 1 with --quick)
  --quick               small, short smoke run (10 s, 10 viewers for board-steady)
  --baseline            write baselines/<version>.json and reports/<version>.md
  --app <name>          app under bench/apps/ (default v4)
  --server-cpus <list>  cpus the server is pinned to (default 2,3)
  --loadgen-cpus <list> cpus the load generator is pinned to (default 10,11)
  --pg-cpus <list>      cpuset for the Postgres container (default 6-9)
  --port <n>            server port (default 4090)
  --pg-port <n>         Postgres host port (default 5544)
  --keep-db             leave the Postgres container running afterwards
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
      app: { type: "string", default: "v4" },
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
    app: values.app,
    serverCpus: values["server-cpus"],
    loadgenCpus: values["loadgen-cpus"],
    pgCpus: values["pg-cpus"],
    port: positiveInt(values.port, "--port"),
    pgPort: positiveInt(values["pg-port"], "--pg-port"),
    keepDb: values["keep-db"],
    args,
  };
}
