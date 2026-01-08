import type { Server as SocketIOServer } from "socket.io";
import type {
  ServiceResponse,
  ServiceMethodDefinition,
  Logger,
} from "../shared/types";
import { consoleLogger } from "../shared/types";
import type {
  QuickdrawSocket,
  BaseServiceInstance,
  ServiceRegistryInstance,
} from "./types";

/**
 * Central registry for auto-discovering and registering service methods as Socket.io events.
 *
 * Features:
 * - Auto-discovers public methods from registered services
 * - Wires methods to Socket.io events with standardized naming
 * - Handles subscription lifecycle
 * - Provides consistent error handling and logging
 *
 * @example
 * ```typescript
 * const registry = new ServiceRegistry(io, { logger });
 * registry.registerService('chatService', chatService);
 * registry.registerService('userService', userService);
 * ```
 */
export class ServiceRegistry implements ServiceRegistryInstance {
  private readonly io: SocketIOServer;
  private readonly services: Map<string, BaseServiceInstance> = new Map();
  private readonly logger: Logger;

  constructor(io: SocketIOServer, options?: { logger?: Logger }) {
    this.io = io;
    this.logger = options?.logger?.child({ service: "ServiceRegistry" }) ??
      consoleLogger.child({ service: "ServiceRegistry" });
  }

  /**
   * Register a service and auto-discover its public methods.
   */
  public registerService(
    serviceName: string,
    service: BaseServiceInstance
  ): void {
    this.services.set(serviceName, service);
    this.logger.info(`Registered service: ${serviceName}`);

    // Auto-discover and wire public methods
    this.discoverServiceMethods(serviceName, service);
  }

  /**
   * Discover and register all public methods from a service.
   */
  private discoverServiceMethods(
    serviceName: string,
    service: BaseServiceInstance
  ): void {
    const methods = service.getPublicMethods();

    for (const method of methods) {
      const eventName = `${serviceName}:${method.name}`;
      this.logger.info(`Registering socket event: ${eventName}`);

      // Register on connection
      this.io.on("connection", (socket) => {
        this.registerMethodListener(
          socket as QuickdrawSocket,
          eventName,
          method,
          service
        );
      });
    }

    // Register subscription handlers
    this.io.on("connection", (socket) => {
      this.registerSubscriptionListener(
        socket as QuickdrawSocket,
        `${serviceName}:subscribe`,
        service
      );
      this.registerUnsubscriptionListener(
        socket as QuickdrawSocket,
        `${serviceName}:unsubscribe`,
        service
      );
    });
  }

  /**
   * Register a method as a socket event listener.
   */
  private registerMethodListener(
    socket: QuickdrawSocket,
    eventName: string,
    method: ServiceMethodDefinition<unknown, unknown>,
    service: BaseServiceInstance
  ): void {
    socket.on(
      eventName,
      async (
        payload: unknown,
        callback?: (response: ServiceResponse<unknown>) => void
      ) => {
        const startedAt = Date.now();
        const [serviceName, methodName] = eventName.split(":");
        const userIdShort = socket.userId?.slice(0, 8) ?? "anon";

        try {
          // Authentication check
          if (!socket.userId && method.access !== "Public") {
            const errorResponse: ServiceResponse<unknown> = {
              success: false,
              error: "Authentication required",
              code: 401,
            };
            callback?.(errorResponse);
            return;
          }

          // Validate payload with Zod schema if provided
          let validatedPayload = payload;
          if (method.schema) {
            const result = method.schema.safeParse(payload);
            if (!result.success) {
              const errorResponse: ServiceResponse<unknown> = {
                success: false,
                error: `Validation error: ${result.error.message}`,
                code: 400,
              };
              callback?.(errorResponse);
              return;
            }
            validatedPayload = result.data;
          }

          // Resolve entry ID for access check
          let entryId: string | undefined;
          if (method.resolveEntryId) {
            entryId = method.resolveEntryId(validatedPayload) ?? undefined;
          } else if (
            validatedPayload &&
            typeof validatedPayload === "object" &&
            "id" in validatedPayload
          ) {
            const idValue = (validatedPayload as Record<string, unknown>).id;
            if (typeof idValue === "string") {
              entryId = idValue;
            }
          }

          // Check access
          await service.ensureAccessForMethod(method.access, socket, entryId);

          // Log start
          this.logger.info(
            `User ${userIdShort} ${serviceName}.${methodName} -> start`,
            {
              category: "request_processing",
              serviceName,
              methodName,
              userId: socket.userId,
              socketId: socket.id,
            }
          );

          // Execute handler
          const result = await method.handler(validatedPayload, {
            userId: socket.userId,
            socketId: socket.id,
            serviceAccess: socket.serviceAccess ?? {},
          });

          const durationMs = Date.now() - startedAt;
          this.logger.info(
            `User ${userIdShort} ${serviceName}.${methodName} -> success`,
            {
              category: "request_processing",
              outcome: "success",
              durationMs,
              serviceName,
              methodName,
              userId: socket.userId,
            }
          );

          const successResponse: ServiceResponse<unknown> = {
            success: true,
            data: result,
          };
          callback?.(successResponse);
        } catch (error) {
          const durationMs = Date.now() - startedAt;
          this.logger.error(
            `User ${userIdShort} ${serviceName}.${methodName} -> fail`,
            {
              category: "request_processing",
              outcome: "fail",
              durationMs,
              error: error instanceof Error ? error.message : "Unknown error",
            }
          );

          const errorResponse: ServiceResponse<unknown> = {
            success: false,
            error: error instanceof Error ? error.message : "Internal error",
            code: 500,
          };
          callback?.(errorResponse);
        }
      }
    );
  }

  /**
   * Register subscription listener for a service.
   */
  private registerSubscriptionListener(
    socket: QuickdrawSocket,
    eventName: string,
    service: BaseServiceInstance
  ): void {
    socket.on(
      eventName,
      async (
        payload: { entryId: string; requiredLevel?: string },
        callback?: (response: ServiceResponse<unknown>) => void
      ) => {
        try {
          if (!socket.userId) {
            callback?.({
              success: false,
              error: "Authentication required",
              code: 401,
            });
            return;
          }

          const data = await service.subscribe(
            payload.entryId,
            socket,
            (payload.requiredLevel as "Read" | "Moderate" | "Admin") ?? "Read"
          );

          if (data === null) {
            callback?.({
              success: false,
              error: "Access denied or entry not found",
              code: 403,
            });
            return;
          }

          callback?.({ success: true, data });
        } catch (error) {
          this.logger.error(`Error in subscription ${eventName}:`, {
            error: error instanceof Error ? error.message : "Unknown error",
          });
          callback?.({
            success: false,
            error: error instanceof Error ? error.message : "Subscription failed",
          });
        }
      }
    );
  }

  /**
   * Register unsubscription listener for a service.
   */
  private registerUnsubscriptionListener(
    socket: QuickdrawSocket,
    eventName: string,
    service: BaseServiceInstance
  ): void {
    socket.on(
      eventName,
      (
        payload: { entryId: string },
        callback?: (
          response: ServiceResponse<{ unsubscribed: true; entryId: string }>
        ) => void
      ) => {
        try {
          service.unsubscribe(payload.entryId, socket);
          callback?.({
            success: true,
            data: { unsubscribed: true, entryId: payload.entryId },
          });
        } catch (error) {
          this.logger.error(`Error in unsubscription ${eventName}:`, {
            error: error instanceof Error ? error.message : "Unknown error",
          });
          callback?.({
            success: false,
            error: error instanceof Error ? error.message : "Unsubscription failed",
          });
        }
      }
    );
  }

  /**
   * Get list of registered service names.
   */
  public getServices(): string[] {
    return Array.from(this.services.keys());
  }

  /**
   * Get all service instances for lifecycle management.
   */
  public getServiceInstances(): BaseServiceInstance[] {
    return Array.from(this.services.values());
  }
}
