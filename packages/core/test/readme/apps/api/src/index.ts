import express, { type Express } from "express";
import { loadGrants, verifySession } from "./auth";
import { db } from "./db";
import { qd } from "./quickdraw";
import { labelService } from "./services/label";
import { projectService } from "./services/project";
import { taskService } from "./services/task";

export const app: Express = express();

export const server = qd.createServer({
  app, // the HTTP transport is mounted on it: POST /qd/{service}/{method}
  services: [labelService, projectService, taskService],
  db,
  cors: { origin: ["http://localhost:3000"], credentials: true },
  auth: {
    // a principal, a user id, or nothing for an anonymous caller
    authenticate: ({ auth }) => verifySession(auth.token),
    loadServiceAccess: (userId) => loadGrants(userId),
    // a tracked write to User.serviceAccess refreshes that user's open sockets
    serviceAccessSource: { model: "user", column: "serviceAccess" },
  },
  handleSignals: true, // close on SIGTERM and SIGINT; the process is never exited
});

server.httpServer.listen(4000);
