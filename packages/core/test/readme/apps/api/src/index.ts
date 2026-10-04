import { socketAuth } from "@fitzzero/quickdraw-core/server/auth";
import express, { type Express } from "express";
import { jwtSecret, loadGrants, sessions } from "./auth";
import { db } from "./db";
import { qd, type AppPrincipal } from "./quickdraw";
import { labelService } from "./services/label";
import { projectService } from "./services/project";
import { taskService } from "./services/task";

// the web app's origins: CORS, and the pages that may open a socket with the session cookie
const webOrigins = ["http://localhost:3000"];

export const app: Express = express();

export const server = qd.createServer({
  // the HTTP transport is mounted on it: POST /qd/{service}/{method}
  app,
  services: [labelService, projectService, taskService],
  db,
  cors: { origin: webOrigins, credentials: true },
  auth: {
    // the session cookie the auth routes set, else a bearer token (`auth.token`); none is anonymous
    authenticate: socketAuth({
      sessions,
      jwtSecret,
      allowedOrigins: webOrigins,
      loadPrincipal: (userId): AppPrincipal => ({ userId, kind: "user" }),
    }),
    loadServiceAccess: (userId) => loadGrants(userId),
    // a tracked write to User.serviceAccess refreshes that user's open sockets
    serviceAccessSource: { model: "user", column: "serviceAccess" },
  },
  // close on SIGTERM and SIGINT; the process is never exited
  handleSignals: true,
});

server.httpServer.listen(4000);
