import { createServer } from "node:http";
import express from "express";
import { Server } from "socket.io";
import { prisma } from "@project/db";
import { HealthService } from "./services/health.js";
import { TaskService } from "./services/task.js";

// #region server
import { ServiceRegistry } from "@fitzzero/quickdraw-core/server";

const app = express();
const httpServer = createServer(app);
const io = new Server(httpServer, { cors: { origin: "*" } });

const registry = new ServiceRegistry(io);
registry.registerService("taskService", new TaskService(prisma));
registry.registerService("healthService", new HealthService());

httpServer.listen(4000);
// #endregion
