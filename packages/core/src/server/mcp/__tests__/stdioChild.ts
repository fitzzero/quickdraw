// The entry the stdio harness spawns (`node --import tsx stdioChild.ts`), as
// an app's MCP entry would be: it starts the server module through
// `bootstrapMcpServer`, so nothing but the protocol reaches stdout.

import { bootstrapMcpServer } from "../bootstrap";

await bootstrapMcpServer(new URL("./stdioServer.ts", import.meta.url));
