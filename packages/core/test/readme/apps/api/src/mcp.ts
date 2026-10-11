// The README's MCP bridge examples.

import { z } from "zod";
import { verifySession } from "./auth";
import { verifyAgentToken } from "./auth/agents";
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
  // handlers read it as ctx.mcp
  context: () => ({ scopes: ["tasks"] }),
  // or include: [...]; name: (service, method) => ...
  exclude: ["projectService.invite"],
  customTools: [
    {
      name: "summarize",
      description: "Counts the tasks of a project.",
      // validated before the handler runs, and types `arguments`
      inputSchema: summarizeInput,
      // access: "authenticated" is the default; "public" lets anonymous callers in
      handler: async ({ arguments: { projectId }, caller }) =>
        `${String(await caller.taskService.countOnBoard({ projectId }))} tasks`,
    },
  ],
});

// GET /mcp/tools, POST /mcp/invoke
app.use(createMcpHttpRouter({ registry }));
// in an MCP client's process
createMcpStdioServer({ registry, name: "my-app", version: "1.0.0" });
// #endregion

// #region bind
// agents bound to one project: an agent's token names it as a verified claim
const projectAgents = createMcpRegistry({
  services: [taskService],
  dispatcher: server.dispatcher,
  // agent tokens only: anyone else is anonymous, and every tool here refuses them
  principal: (request) =>
    verifyAgentToken(request.transport === "http" ? request.token : process.env.AGENT_TOKEN),
  // filled from the claim on every call, and left out of every tool's arguments
  bind: { projectId: ({ principal }) => principal.claims?.projectId },
  include: ["taskService.create", "taskService.countOnBoard"],
  // the tools' public names: create_task and count_tasks
  name: (_service, method) => (method === "create" ? "create_task" : "count_tasks"),
});

// beside the first registry, at a path of its own: GET /agents/tools, POST /agents/invoke
app.use(createMcpHttpRouter({ registry: projectAgents, path: "/agents" }));
// #endregion
