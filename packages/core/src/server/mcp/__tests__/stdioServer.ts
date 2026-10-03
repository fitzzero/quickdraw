// The MCP server module of the stdio harness: what an app's own server module
// looks like. `stdioChild.ts` loads it through `bootstrapMcpServer`, so the
// console output below, and the dispatcher's per-call log entries (its
// default logger is the console), must all reach stderr, never stdout.

import { createDispatcher } from "../../index";
import { createMcpRegistry, createMcpStdioServer } from "../index";
import { agentAuth, createServices } from "./fixtures";

// oxlint-disable-next-line no-console -- the harness checks that bootstrapMcpServer sends this to stderr
console.log("stdio harness: console output while the server module loads");

const { taskService, noteService } = createServices();
const services = [taskService, noteService] as const;
const dispatcher = createDispatcher({ services });
const registry = createMcpRegistry({
  services,
  dispatcher,
  ...agentAuth(() => process.env.QD_MCP_TOKEN ?? null),
});
const server = createMcpStdioServer({ registry, name: "quickdraw-harness", version: "0.0.0" });
// The test waits for this line before it sends anything.
process.stderr.write("stdio harness: ready\n");
await server.closed;
process.stderr.write("stdio harness: closed\n");
