import { consoleLogger } from "../../shared/types";
import type { Logger } from "../../shared/types";
import type {
  McpRegistryOptions,
  McpRegistryInstance,
  McpServiceInstance,
  McpMethodDefinition,
  McpToolDefinition,
  McpSocketContext,
  ServiceToolSpec,
} from "./types";

export class McpRegistry implements McpRegistryInstance {
  private services = new Map<string, McpServiceInstance>();
  private methodCache = new Map<string, Map<string, McpMethodDefinition>>();
  private readonly hydrateUserContext: McpRegistryOptions["hydrateUserContext"];
  private readonly logger: Logger;
  private customToolSpecs: ServiceToolSpec[] | null = null;

  constructor(options: McpRegistryOptions) {
    this.hydrateUserContext = options.hydrateUserContext;
    this.logger =
      options.logger?.child({ service: "McpRegistry" }) ??
      consoleLogger.child({ service: "McpRegistry" });
  }

  /**
   * Optionally provide pre-generated tool specs for richer descriptions.
   * If not set, tool definitions are built dynamically from registered services.
   */
  setToolSpecs(specs: ServiceToolSpec[]): void {
    this.customToolSpecs = specs;
  }

  registerService(
    serviceName: string,
    serviceInstance: McpServiceInstance,
  ): void {
    this.services.set(serviceName, serviceInstance);

    const methods = serviceInstance.getPublicMethods?.() ?? [];
    const methodMap = new Map<string, McpMethodDefinition>();
    for (const method of methods) {
      methodMap.set(method.name, method);
    }
    this.methodCache.set(serviceName, methodMap);

    this.logger.info(`Registered MCP service: ${serviceName}`, {
      category: "startup",
      methodCount: methods.length,
      methods: methods.map((m) => m.name),
    });
  }

  listTools(options?: { defaultUserId?: string }): McpToolDefinition[] {
    const hasDefaultUser = !!options?.defaultUserId;

    if (this.customToolSpecs) {
      return this.customToolSpecs
        .filter((s) => this.services.has(s.name))
        .map((svc) => this.buildToolDefinition(svc.name, svc.description, svc.methodNames, hasDefaultUser));
    }

    const tools: McpToolDefinition[] = [];
    for (const [serviceName] of this.services) {
      const methodMap = this.methodCache.get(serviceName);
      if (!methodMap) continue;
      const methodNames = Array.from(methodMap.keys());
      const description = this.buildDescription(serviceName, methodNames);
      tools.push(this.buildToolDefinition(serviceName, description, methodNames, hasDefaultUser));
    }
    return tools;
  }

  async invoke(
    serviceName: string,
    methodName: string,
    payload: unknown,
    userId: string,
  ): Promise<unknown> {
    const { instance, method } = this.resolveServiceMethod(serviceName, methodName);

    const { serviceAccess } = await this.hydrateUserContext(userId);
    const ctx: McpSocketContext = {
      id: `mcp-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      userId,
      serviceAccess,
      connected: true,
      disconnected: false,
    };

    const entryId = this.resolveEntryId(method, payload);
    const logTag = `${serviceName}.${methodName}`;

    this.logger.info(`MCP invoke start: ${logTag}`, {
      category: "request_processing",
      source: "mcp",
      serviceName,
      methodName,
      userId,
      entryId,
    });

    const startTime = Date.now();
    try {
      const validatedPayload = this.validatePayload(method, payload);

      if (instance.ensureAccessForMethod) {
        await instance.ensureAccessForMethod(
          method.access,
          ctx as never,
          entryId,
        );
      }

      const result = await method.handler(validatedPayload, {
        userId,
        socketId: ctx.id,
        serviceAccess,
      });

      this.logger.info(`MCP invoke success: ${logTag}`, {
        category: "request_processing",
        outcome: "success",
        source: "mcp",
        serviceName,
        methodName,
        userId,
        durationMs: Date.now() - startTime,
      });
      return result;
    } catch (error) {
      this.logger.error(`MCP invoke error: ${logTag}`, {
        category: "error",
        source: "mcp",
        serviceName,
        methodName,
        userId,
        error: error instanceof Error ? error.message : String(error),
        durationMs: Date.now() - startTime,
      });
      throw error;
    }
  }

  getServices(): string[] {
    return Array.from(this.services.keys());
  }

  private resolveServiceMethod(
    serviceName: string,
    methodName: string,
  ): { instance: McpServiceInstance; method: McpMethodDefinition } {
    const instance = this.services.get(serviceName);
    if (!instance) {
      throw new Error(
        `Unknown service: ${serviceName}. Available: ${Array.from(this.services.keys()).join(", ")}`,
      );
    }

    const methodMap = this.methodCache.get(serviceName);
    const method = methodMap?.get(methodName);
    if (!method) {
      throw new Error(
        `Unknown method "${methodName}" on ${serviceName}. Available: ${Array.from(methodMap?.keys() ?? []).join(", ")}`,
      );
    }

    return { instance, method };
  }

  private validatePayload(
    method: McpMethodDefinition,
    payload: unknown,
  ): unknown {
    if (method.schema) {
      const result = method.schema.safeParse(payload);
      if (!result.success) {
        throw new Error(
          `Validation error: ${result.error?.message ?? "invalid payload"}`,
        );
      }
      return result.data;
    }
    return payload;
  }

  private resolveEntryId(
    method: McpMethodDefinition,
    payload: unknown,
  ): string | undefined {
    if (method.resolveEntryId) {
      return method.resolveEntryId(payload) ?? undefined;
    }
    if (payload && typeof payload === "object" && "id" in payload) {
      const v = (payload as Record<string, unknown>).id;
      return typeof v === "string" ? v : undefined;
    }
    return undefined;
  }

  private buildToolDefinition(
    name: string,
    description: string,
    methodNames: string[],
    hasDefaultUser: boolean,
  ): McpToolDefinition {
    return {
      name,
      description,
      inputSchema: {
        type: "object",
        properties: {
          method: {
            type: "string",
            enum: methodNames,
            description: "The service method to call",
          },
          payload: {
            type: "object",
            description:
              "Method-specific payload (see method listing in description for fields)",
          },
          userId: {
            type: "string",
            description: hasDefaultUser
              ? "User ID (optional - defaults to MCP_USER_ID env var)"
              : "The authenticated user ID (required for ACL checks)",
          },
        },
        required: hasDefaultUser ? ["method"] : ["method", "userId"],
      },
    };
  }

  private buildDescription(
    serviceName: string,
    methodNames: string[],
  ): string {
    const displayName =
      serviceName.replace(/Service$/i, "").replace(/([a-z])([A-Z])/g, "$1 $2") +
      "Service";
    const methodList = methodNames.map((m) => `- ${m}`).join("\n");
    return `${displayName} service.\n\nMethods:\n${methodList}`;
  }
}
