import type { AccessLevel, Logger } from "../../shared/types";

export interface McpRegistryOptions {
  hydrateUserContext: (userId: string) => Promise<{
    serviceAccess: Record<string, AccessLevel>;
  }>;
  logger?: Logger;
}

export interface McpStdioServerOptions {
  name: string;
  version: string;
  registry: McpRegistryInstance;
  defaultUserId?: string;
}

export interface McpHttpRoutesOptions {
  registry: McpRegistryInstance;
  verifyToken: (token: string) => Promise<{ userId: string } | null>;
  logger?: Logger;
}

export interface MethodSpec {
  name: string;
  access: AccessLevel;
  entryScoped: boolean;
  payloadHint: string;
}

export interface ServiceToolSpec {
  name: string;
  description: string;
  methods: MethodSpec[];
  methodNames: string[];
}

export interface McpToolDefinition {
  name: string;
  description: string;
  inputSchema: {
    type: "object";
    properties: Record<string, unknown>;
    required?: string[];
  };
}

export interface McpRegistryInstance {
  registerService(serviceName: string, serviceInstance: McpServiceInstance): void;
  listTools(options?: { defaultUserId?: string }): McpToolDefinition[];
  invoke(
    serviceName: string,
    methodName: string,
    payload: unknown,
    userId: string,
  ): Promise<unknown>;
  getServices(): string[];
}

export interface McpServiceInstance {
  getPublicMethods?: () => McpMethodDefinition[];
  ensureAccessForMethod?: (
    access: AccessLevel,
    ctx: unknown,
    entryId?: string,
  ) => Promise<void>;
}

export interface McpMethodDefinition {
  name: string;
  access: AccessLevel;
  handler: (payload: unknown, context: McpMethodContext) => Promise<unknown>;
  schema?: {
    safeParse: (data: unknown) => {
      success: boolean;
      data?: unknown;
      error?: { message: string };
    };
  };
  resolveEntryId?: (payload: unknown) => string | null;
}

export interface McpMethodContext {
  userId: string;
  socketId: string;
  serviceAccess: Record<string, AccessLevel>;
}

export interface McpSocketContext {
  id: string;
  userId?: string;
  serviceAccess?: Record<string, AccessLevel>;
  connected: boolean;
  disconnected: boolean;
}

export interface GenerateToolMetadataOptions {
  servicesDir: string;
  toolsOutputPath: string;
  docsOutputDir?: string;
}

export interface ServiceInfo {
  name: string;
  className: string;
  hasEntryACL: boolean;
  aclPattern: string;
  methods: ServiceMethodInfo[];
  schemas: Map<string, string>;
}

export interface ServiceMethodInfo {
  name: string;
  accessLevel: string;
  hasSchema: boolean;
  schemaName?: string;
  hasResolver: boolean;
  payloadFields?: string[];
}
