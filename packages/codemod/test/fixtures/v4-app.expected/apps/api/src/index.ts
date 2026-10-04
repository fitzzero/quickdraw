import { createServer } from "node:http";
import express from "express";
import { Server as SocketIOServer } from "socket.io";
// quickdraw-migrate: review [v4-api] 4.x API ServiceRegistry (removed): lint's no-v4-api names each replacement
import { ServiceRegistry } from "@fitzzero/quickdraw-core/server";
import { healthService } from "./services/health.js";
import { labelService } from "./services/label.js";
import { projectService } from "./services/project.js";
import { taskService } from "./services/task/index.js";
import { userService } from "./services/user.js";

const app = express();
const httpServer = createServer(app);
const io = new SocketIOServer(httpServer, { cors: { origin: "http://localhost:3000" } });

const serviceRegistry = new ServiceRegistry(io);
// quickdraw-migrate: review [server] the 4.x service was constructed here (new ProjectService(...)): it is the object projectService now; pass it in qd.createServer({ services: [...] })
serviceRegistry.registerService("projectService", projectService);
// quickdraw-migrate: review [server] the 4.x service was constructed here (new TaskService(...)): it is the object taskService now; pass it in qd.createServer({ services: [...] })
serviceRegistry.registerService("taskService", taskService);
// quickdraw-migrate: review [server] the 4.x service was constructed here (new UserService(...)): it is the object userService now; pass it in qd.createServer({ services: [...] })
serviceRegistry.registerService("userService", userService);
// quickdraw-migrate: review [server] the 4.x service was constructed here (new LabelService(...)): it is the object labelService now; pass it in qd.createServer({ services: [...] })
serviceRegistry.registerService("labelService", labelService);
// quickdraw-migrate: review [server] the 4.x service was constructed here (new HealthService(...)): it is the object healthService now; pass it in qd.createServer({ services: [...] })
serviceRegistry.registerService("healthService", healthService);

httpServer.listen(4000);
