import { verifyJWT } from "@fitzzero/quickdraw-core/server/auth";
import express from "express";
import { db, prisma } from "./database";
import { mountBenchRoutes } from "./harness";
import { Metrics } from "./instrument";
import { qd } from "./quickdraw";
import { projectService } from "./services/project";
import { taskService } from "./services/task";

/**
 * The 5.0 benchmark server: the README's `qd.createServer` on the app's own
 * Express app, with JWT auth and every other option at its 5.0 default
 * (console logger, JSON-only parser, no access cache, the in-process change
 * log, the socket rate limiter). The only additions are the harness's routes
 * (src/harness.ts) and the measurement in src/instrument.ts.
 *
 * The rate limiter's default, 600 events per minute per socket, covers this
 * workload, which 4.1 serves without any limiter: a writer sends 120 writes a
 * minute and a viewer fetches the board query at most four times a second
 * (240 a minute). The 5.0.0 report's runs allowed 1,000 because the default
 * was 100 then, which refused part of the work (`reports/5.0.0.md`).
 */

const port = Number(process.env.PORT ?? "4090");
const jwtSecret = process.env.JWT_SECRET ?? "quickdraw-bench-secret";

const metrics = new Metrics(prisma);
const app = express();
mountBenchRoutes(app, metrics, jwtSecret);

const server = qd.createServer({
  app,
  services: [projectService, taskService],
  db,
  cors: { origin: "*" },
  onCall: metrics.onCall,
  auth: {
    authenticate: async ({ auth }) => {
      const payload = await verifyJWT(String(auth.token ?? ""), jwtSecret);
      return payload?.userId;
    },
  },
});
metrics.attach(server.httpServer, server.io);
server.httpServer.listen(port);
