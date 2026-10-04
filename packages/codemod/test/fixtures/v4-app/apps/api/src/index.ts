import { createServer } from "node:http";
import express from "express";
import { Server as SocketIOServer } from "socket.io";
import { ServiceRegistry } from "@fitzzero/quickdraw-core/server";
import { prisma } from "@project/db";
import { HealthService } from "./services/health.js";
import { LabelService } from "./services/label.js";
import { ProjectService } from "./services/project.js";
import { TaskService } from "./services/task/index.js";
import { UserService } from "./services/user.js";

const app = express();
const httpServer = createServer(app);
const io = new SocketIOServer(httpServer, { cors: { origin: "http://localhost:3000" } });

const serviceRegistry = new ServiceRegistry(io);
serviceRegistry.registerService("projectService", new ProjectService(prisma));
serviceRegistry.registerService("taskService", new TaskService(prisma));
serviceRegistry.registerService("userService", new UserService(prisma));
serviceRegistry.registerService("labelService", new LabelService(prisma));
serviceRegistry.registerService("healthService", new HealthService(prisma));

httpServer.listen(4000);
