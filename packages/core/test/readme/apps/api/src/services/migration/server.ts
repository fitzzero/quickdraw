import { socketAuth } from "@fitzzero/quickdraw-core/server/auth";
import express, { type Express } from "express";
import { jwtSecret, sessions } from "../../auth";
import { db } from "../../db";
import { qd, type AppPrincipal } from "../../quickdraw";
import { healthService } from "./health";
import { taskService } from "./task";

const app: Express = express();

// #region server
// was new ServiceRegistry(io) plus registerService(...) per service
export const server = qd.createServer({
  app,
  services: [taskService, healthService],
  db,
  cors: { origin: ["https://app.example.com"], credentials: true },
  // the session cookie from an allowed page, or a bearer token, checked against the store
  auth: {
    authenticate: socketAuth({
      sessions,
      jwtSecret,
      allowedOrigins: ["https://app.example.com"],
      loadPrincipal: (userId): AppPrincipal => ({ userId, kind: "user" }),
    }),
  },
  // 4.x clients keep calling `socket.emit("taskService:renameTask", ...)` until they update
  legacyWire: true,
});
// #endregion
