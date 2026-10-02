import { fileURLToPath } from "node:url";
import { join } from "node:path";

/** The bench/ directory. */
export const BENCH_DIR = fileURLToPath(new URL("..", import.meta.url));

/** Ad-hoc run output, server logs and the generated workload (gitignored). */
export const RESULTS_DIR = join(BENCH_DIR, "results");
/** Committed baselines, one JSON file per measured version. */
export const BASELINES_DIR = join(BENCH_DIR, "baselines");
/** Committed Markdown reports next to the baselines. */
export const REPORTS_DIR = join(BENCH_DIR, "reports");
export const COMPOSE_FILE = join(BENCH_DIR, "docker-compose.yml");
export const SCHEMA_FILE = join(BENCH_DIR, "result.schema.json");

export function appDir(app: string): string {
  return join(BENCH_DIR, "apps", app);
}
