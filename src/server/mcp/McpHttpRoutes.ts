import type { Router, Request, Response } from "express";
import { consoleLogger } from "../../shared/types";
import type { McpHttpRoutesOptions } from "./types";

/**
 * Create Express routes for MCP tool discovery and invocation.
 *
 * Mounts:
 *   GET  /mcp/tools   - List available MCP tools
 *   POST /mcp/invoke  - Invoke a tool with Bearer JWT auth
 */
export function createMcpRoutes(router: Router, options: McpHttpRoutesOptions): Router {
  const { registry, verifyToken } = options;
  const logger =
    options.logger?.child({ service: "McpHttpRoutes" }) ??
    consoleLogger.child({ service: "McpHttpRoutes" });

  router.get("/mcp/tools", (_req: Request, res: Response) => {
    const tools = registry.listTools();
    res.json({ tools });
  });

  router.post("/mcp/invoke", async (req: Request, res: Response) => {
    try {
      const authHeader = req.headers.authorization;
      if (!authHeader?.startsWith("Bearer ")) {
        res.status(401).json({ error: "Missing or invalid Authorization header" });
        return;
      }

      const token = authHeader.slice(7);
      const tokenPayload = await verifyToken(token);
      if (!tokenPayload?.userId) {
        res.status(401).json({ error: "Invalid token" });
        return;
      }

      const {
        service,
        method,
        payload: toolPayload,
      } = req.body as {
        service: string;
        method: string;
        payload?: unknown;
      };

      if (!service || !method) {
        res.status(400).json({ error: "Missing service or method" });
        return;
      }

      const result = await registry.invoke(service, method, toolPayload, tokenPayload.userId);
      res.json({ success: true, data: result });
    } catch (error) {
      const message = error instanceof Error ? error.message : "Internal error";
      logger.error("MCP HTTP invoke error", { error: message });
      res.status(500).json({ error: message });
    }
  });

  return router;
}
