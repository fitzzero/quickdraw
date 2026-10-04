// The README's observability example.

import { app } from "./index";
import { db } from "./db";
import { qd } from "./quickdraw";
import { projectService } from "./services/project";
import { taskService } from "./services/task";

const services = [projectService, taskService];

// #region otel
import { metrics, trace } from "@opentelemetry/api";
import { otelOnCall } from "@fitzzero/quickdraw-core/server/otel";

export const server = qd.createServer({
  app,
  services,
  db,
  // warns when the event loop's p99 delay passes 200 ms
  stallWatchdog: true,
  onCall: otelOnCall({ meter: metrics.getMeter("api"), tracer: trace.getTracer("api") }),
});
// #endregion
