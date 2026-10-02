import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { COMPOSE_FILE } from "../paths";
import { run, runOrThrow, type RunOptions } from "./exec";
import { assertPortFree } from "./ports";

/**
 * The benchmark's own Postgres (bench/docker-compose.yml, compose project
 * "quickdraw-bench"). It never touches another compose project or container.
 */

export const COMPOSE_PROJECT = "quickdraw-bench";
const USER = "bench";
const DATABASE = "quickdraw_bench";
const PSQL = [
  "exec",
  "-T",
  "postgres",
  "psql",
  "-v",
  "ON_ERROR_STOP=1",
  "-q",
  "-U",
  USER,
  "-d",
  DATABASE,
];

export interface Database {
  url: string;
  /** True when this run started the container, so it also stops it. */
  startedHere: boolean;
  /** The container's cpuset as Docker reports it. */
  cpus: string | null;
  version: string | null;
}

export interface DatabaseOptions {
  port: number;
  cpus: string;
  appDir: string;
}

async function compose(args: string[], options: RunOptions = {}): Promise<string> {
  const base = ["compose", "-f", COMPOSE_FILE, "-p", COMPOSE_PROJECT];
  return await runOrThrow("docker", [...base, ...args], options);
}

async function query(sql: string): Promise<string> {
  return (await compose([...PSQL, "-tA", "-c", sql])).trim();
}

async function containerId(): Promise<string> {
  return (await compose(["ps", "-q", "postgres"])).trim();
}

/** Start the container if it is not running, then create the app's tables if they are missing. */
export async function ensureDatabase(options: DatabaseOptions): Promise<Database> {
  let id = await containerId();
  const startedHere = id === "";
  if (startedHere) {
    await assertPortFree(options.port, "127.0.0.1", "benchmark Postgres");
    await compose(["up", "-d", "--wait"], {
      env: { BENCH_PG_PORT: String(options.port), BENCH_PG_CPUS: options.cpus },
    });
    id = await containerId();
  }
  const exists = await query(`select to_regclass('public."Task"') is not null`);
  if (exists !== "t") {
    const ddl = await readFile(join(options.appDir, "prisma", "schema.sql"), "utf8");
    await compose(PSQL, { input: ddl });
  }
  const inspect = await run("docker", ["inspect", "--format", "{{.HostConfig.CpusetCpus}}", id]);
  const address = (await compose(["port", "postgres", "5432"])).trim();
  return {
    url: `postgresql://${USER}:${USER}@${address}/${DATABASE}`,
    startedHere,
    cpus: inspect.code === 0 ? inspect.stdout.trim() : null,
    version: await query("show server_version").catch(() => null),
  };
}

/** Stop and remove only this project's container and its volume. */
export async function stopDatabase(): Promise<void> {
  await compose(["down", "-v", "--remove-orphans"]);
}
