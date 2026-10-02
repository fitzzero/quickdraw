import { readFileSync } from "node:fs";
import type { IncomingMessage, Server as HttpServer, ServerResponse } from "node:http";
import { createJWT, createQuickdrawServer, verifyJWT } from "@fitzzero/quickdraw-core/server";
import { createPrisma, databaseUrl, DB_POOL_MAX } from "./db";
import { Metrics } from "./instrument";
import { ProjectService } from "./services/ProjectService";
import { TaskService } from "./services/TaskService";

/**
 * The 4.1 benchmark server: the README's `createQuickdrawServer` setup with
 * JWT auth and every option left at its 4.1 default (method logging on,
 * console logger). The only additions are the harness's /bench/* routes.
 */

const port = Number(process.env.PORT ?? "4090");
const jwtSecret = process.env.JWT_SECRET ?? "quickdraw-bench-secret";

const prisma = createPrisma(databaseUrl());
const metrics = new Metrics(prisma);

const projectService = new ProjectService(prisma);
const taskService = new TaskService(prisma, projectService);
metrics.instrument(projectService);
metrics.instrument(taskService);

const { io, httpServer } = createQuickdrawServer({
  port,
  cors: { origin: "*" },
  services: { projectService, taskService },
  auth: {
    authenticate: async (_socket, auth) => {
      const payload = await verifyJWT(String(auth.token ?? ""), jwtSecret);
      return payload?.userId;
    },
  },
});
metrics.attach(httpServer, io);

function packageVersion(name: string): string {
  const url = new URL(`../node_modules/${name}/package.json`, import.meta.url);
  return (JSON.parse(readFileSync(url, "utf8")) as { version: string }).version;
}

async function mintTokens(): Promise<Record<string, string>> {
  const users = await prisma.user.findMany({ select: { id: true }, orderBy: { id: "asc" } });
  const entries = await Promise.all(
    users.map(async (user) => [user.id, await createJWT({ userId: user.id }, jwtSecret, "1d")]),
  );
  return Object.fromEntries(entries) as Record<string, string>;
}

type Route = () => unknown;

const routes: Record<string, Route> = {
  "GET /bench/info": () => ({
    app: "v4",
    pid: process.pid,
    node: process.version,
    versions: {
      "@fitzzero/quickdraw-core": packageVersion("@fitzzero/quickdraw-core"),
      "socket.io": packageVersion("socket.io"),
      "@prisma/client": packageVersion("@prisma/client"),
      "@prisma/adapter-pg": packageVersion("@prisma/adapter-pg"),
      pg: packageVersion("pg"),
    },
    dbPoolMax: DB_POOL_MAX,
    logging: "4.1 defaults: method logging on, console logger",
  }),
  "GET /bench/tokens": mintTokens,
  "GET /bench/metrics": () => metrics.read(),
  "POST /bench/metrics/reset": () => {
    metrics.reset();
    return { ok: true };
  },
};

/** Serve /bench/* ahead of Socket.IO and Express, which keep everything else. */
function installBenchRoutes(server: HttpServer): void {
  const existing = server.listeners("request") as Array<
    (req: IncomingMessage, res: ServerResponse) => void
  >;
  server.removeAllListeners("request");
  server.on("request", (req: IncomingMessage, res: ServerResponse) => {
    const route = routes[`${req.method ?? "GET"} ${(req.url ?? "").split("?")[0] ?? ""}`];
    if (!route) {
      for (const listener of existing) listener.call(server, req, res);
      return;
    }
    Promise.resolve()
      .then(route)
      .then(
        (body) => {
          res.writeHead(200, { "content-type": "application/json" });
          res.end(JSON.stringify(body));
        },
        (error: unknown) => {
          res.writeHead(500, { "content-type": "application/json" });
          res.end(
            JSON.stringify({ error: error instanceof Error ? error.message : String(error) }),
          );
        },
      );
  });
}

installBenchRoutes(httpServer);
