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
 * log), except the socket rate limiter's ceiling below. The only additions
 * are the harness's routes (src/harness.ts) and the measurement in
 * src/instrument.ts.
 */

const port = Number(process.env.PORT ?? "4090");
const jwtSecret = process.env.JWT_SECRET ?? "quickdraw-bench-secret";

/**
 * Socket events allowed per minute per socket. 5.0 limits every socket to
 * 100 by default, where 4.1 had no limit at all; this board's writers send
 * 120 writes a minute and its viewers fetch the board query up to four times
 * a second, so the default would refuse part of the work the 4.1 app does.
 * Raised rather than turned off, so the limiter's own cost stays measured.
 */
const SOCKET_EVENTS_PER_MINUTE = 1_000;

const metrics = new Metrics(prisma);
const app = express();
mountBenchRoutes(app, metrics, jwtSecret);

const server = qd.createServer({
  app,
  services: [projectService, taskService],
  db,
  cors: { origin: "*" },
  rateLimit: { maxRequests: SOCKET_EVENTS_PER_MINUTE },
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
