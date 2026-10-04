import { existsSync, readFileSync, realpathSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { createJWT } from "@fitzzero/quickdraw-core/server/auth";
import type { Express } from "express";
import { db } from "./database";
import { DB_POOL_MAX } from "./db";
import type { Metrics } from "./instrument";

/**
 * The bench runner's routes, which every app under bench/apps/ serves with
 * the same fields (see bench/README.md, "Adding an app"): GET /health,
 * GET /bench/info, GET /bench/tokens, GET /bench/metrics and
 * POST /bench/metrics/reset. Not part of the app the benchmark measures.
 */

const appDir = fileURLToPath(new URL("..", import.meta.url));

/** The version of the `name` package Node finds from `dir`: the nearest node_modules up. */
function versionOf(name: string, dir = appDir): string {
  for (let at = dir; ; at = dirname(at)) {
    const path = join(at, "node_modules", name, "package.json");
    if (existsSync(path)) {
      return (JSON.parse(readFileSync(path, "utf8")) as { version: string }).version;
    }
    if (dirname(at) === at) return "unknown";
  }
}

/** Where the framework itself lives: its own dependencies are found from there. */
const coreDir = realpathSync(join(appDir, "node_modules", "@fitzzero", "quickdraw-core"));

function info(): Record<string, unknown> {
  return {
    app: "v5",
    pid: process.pid,
    node: process.version,
    versions: {
      "@fitzzero/quickdraw-core": versionOf("@fitzzero/quickdraw-core"),
      // The framework's own copy, which is the one its server runs on.
      "socket.io": versionOf("socket.io", coreDir),
      "@prisma/client": versionOf("@prisma/client"),
      "@prisma/adapter-pg": versionOf("@prisma/adapter-pg"),
      pg: versionOf("pg"),
    },
    dbPoolMax: DB_POOL_MAX,
    logging: "5.0 defaults: console logger, one debug record per call",
  };
}

async function mintTokens(jwtSecret: string): Promise<Record<string, string>> {
  const users = await db.user.findMany({ select: { id: true }, orderBy: { id: "asc" } });
  const entries = await Promise.all(
    users.map(async (user) => [user.id, await createJWT({ userId: user.id }, jwtSecret, "1d")]),
  );
  return Object.fromEntries(entries) as Record<string, string>;
}

/** Mounts the harness routes on the app, ahead of the framework's HTTP transport. */
export function mountBenchRoutes(app: Express, metrics: Metrics, jwtSecret: string): void {
  app.get("/health", (_req, res) => {
    res.json({ ok: true });
  });
  app.get("/bench/info", (_req, res) => {
    res.json(info());
  });
  app.get("/bench/tokens", (_req, res, next) => {
    mintTokens(jwtSecret).then((tokens) => res.json(tokens), next);
  });
  app.get("/bench/metrics", (_req, res) => {
    res.json(metrics.read());
  });
  app.post("/bench/metrics/reset", (_req, res) => {
    metrics.reset();
    res.json({ ok: true });
  });
}
