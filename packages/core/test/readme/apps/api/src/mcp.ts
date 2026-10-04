// The README's MCP bridge example.

import { z } from "zod";
import { verifySession } from "./auth";
import { app, server } from "./index";
import { projectService } from "./services/project";
import { taskService } from "./services/task";

// #region mcp
import {
  createMcpHttpRouter,
  createMcpRegistry,
  createMcpStdioServer,
} from "@fitzzero/quickdraw-core/server/mcp";

const summarizeInput = z.object({ projectId: z.string() });

const registry = createMcpRegistry({
  services: [projectService, taskService],
  dispatcher: server.dispatcher,
  // who a stdio session or an HTTP bearer token stands for; nothing is anonymous
  principal: (request) =>
    verifySession(request.transport === "http" ? request.token : process.env.AGENT_TOKEN),
  context: () => ({ scopes: ["tasks"] }), // handlers read it as ctx.mcp
  exclude: ["projectService.invite"], // or include: [...]; name: (service, method) => ...
  customTools: [
    {
      name: "summarize",
      description: "Counts the tasks of a project.",
      inputSchema: summarizeInput, // validated before the handler runs, and types `arguments`
      // access: "authenticated" is the default; "public" lets anonymous callers in
      handler: async ({ arguments: { projectId }, caller }) =>
        `${String(await caller.taskService.countOnBoard({ projectId }))} tasks`,
    },
  ],
});

app.use(createMcpHttpRouter({ registry })); // GET /mcp/tools, POST /mcp/invoke
createMcpStdioServer({ registry, name: "my-app", version: "1.0.0" }); // in an MCP client's process
// #endregion
