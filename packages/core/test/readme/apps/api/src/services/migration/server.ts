import express, { type Express } from "express";
import { verifySession } from "../../auth";
import { db } from "../../db";
import { qd } from "../../quickdraw";
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
  auth: { authenticate: ({ auth }) => verifySession(auth.token) },
  // 4.x clients keep calling `socket.emit("taskService:renameTask", ...)` until they update
  legacyWire: true,
  // a busy board sends more than the default 100 socket events per minute
  rateLimit: { maxRequests: 1_000 },
});
// #endregion
