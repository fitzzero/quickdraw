import type { Server as SocketIOServer } from "socket.io";
import type {
  ServiceResponse,
  ServiceMethodDefinition,
  ServiceChannelDefinition,
  Logger,
} from "../shared/types";
import { consoleLogger, channelEventName } from "../shared/types";
import type { QuickdrawSocket, BaseServiceInstance, ServiceRegistryInstance } from "./types";

/**
 * Channel abuse guard: if a socket's dropped-message count within this window
 * exceeds ratePerSecond × CHANNEL_ABUSE_MULTIPLIER, the socket is disconnected.
 * At 30 msg/s this means sustained sending above ~10× the allowed rate.
 */
const CHANNEL_ABUSE_WINDOW_MS = 10_000;
const CHANNEL_ABUSE_MULTIPLIER = 100;

/**
 * Central registry for auto-discovering and registering service methods as Socket.io events.
 *
 * Features:
 * - Auto-discovers public methods from registered services
 * - Wires methods to Socket.io events with standardized naming
 * - Handles subscription lifecycle
 * - Provides consistent error handling and logging
 * - Uses a single connection handler for all services (memory efficient)
 *
 * @example
 * ```typescript
 * const registry = new ServiceRegistry(io, { logger });
 * registry.registerService('chatService', chatService);
 * registry.registerService('userService', userService);
 * ```
 */
export interface ServiceRegistryOptions {
  logger?: Logger;
  /**
   * Automatic method logging configuration.
   * @default { enabled: true, logPayloads: false, logResponses: false }
   */
  methodLogging?: {
    enabled?: boolean;
    logPayloads?: boolean;
    logResponses?: boolean;
  };
}

export class ServiceRegistry implements ServiceRegistryInstance {
  private readonly io: SocketIOServer;
  private readonly services: Map<string, BaseServiceInstance> = new Map();
  private readonly logger: Logger;
  private readonly methodLoggingEnabled: boolean;
  private readonly logPayloads: boolean;
  private readonly logResponses: boolean;
  private connectionHandlerInstalled = false;

  // Store method metadata for deferred registration
  private readonly methodRegistry: Map<
    string,
    {
      serviceName: string;
      method: ServiceMethodDefinition<unknown, unknown>;
      service: BaseServiceInstance;
    }
  > = new Map();

  // Store channel metadata for deferred registration
  private readonly channelRegistry: Map<
    string,
    {
      serviceName: string;
      channel: ServiceChannelDefinition<unknown>;
      service: BaseServiceInstance;
    }
  > = new Map();

  constructor(io: SocketIOServer, options?: ServiceRegistryOptions) {
    this.io = io;
    this.logger =
      options?.logger?.child({ service: "ServiceRegistry" }) ??
      consoleLogger.child({ service: "ServiceRegistry" });

    // Method logging configuration (enabled by default)
    this.methodLoggingEnabled = options?.methodLogging?.enabled ?? true;
    this.logPayloads = options?.methodLogging?.logPayloads ?? false;
    this.logResponses = options?.methodLogging?.logResponses ?? false;

    if (this.methodLoggingEnabled) {
      this.logger.info("Automatic method logging enabled", {
        logPayloads: this.logPayloads,
        logResponses: this.logResponses,
      });
    }
  }

  /**
   * Install the single connection handler that wires all registered services.
   * This is called lazily on first service registration.
   */
  private installConnectionHandler(): void {
    if (this.connectionHandlerInstalled) return;
    this.connectionHandlerInstalled = true;

    this.io.on("connection", (socket) => {
      const quickdrawSocket = socket as QuickdrawSocket;
      this.setupSocketListeners(quickdrawSocket);
    });

    this.logger.info("Installed single connection handler for all services");
  }

  /**
   * Set up all event listeners for a newly connected socket.
   */
  private setupSocketListeners(socket: QuickdrawSocket): void {
    // Register method listeners for all registered services
    for (const [eventName, { method, service }] of this.methodRegistry) {
      this.registerMethodListener(socket, eventName, method, service);
    }

    // Register channel listeners for all registered services
    for (const [eventName, { channel, service }] of this.channelRegistry) {
      this.registerChannelListener(socket, eventName, channel, service);
    }

    // Register subscription/unsubscription listeners for all services
    for (const [serviceName, service] of this.services) {
      this.registerSubscriptionListener(socket, `${serviceName}:subscribe`, service);
      this.registerBatchSubscriptionListener(socket, `${serviceName}:batchSubscribe`, service);
      this.registerUnsubscriptionListener(socket, `${serviceName}:unsubscribe`, service);
    }
  }

  /**
   * Register a service and auto-discover its public methods.
   */
  public registerService(serviceName: string, service: BaseServiceInstance): void {
    this.services.set(serviceName, service);

    // Pass io instance to service for room-based broadcasts
    if (service.setIo) {
      service.setIo(this.io);
    }

    this.logger.info(`Registered service: ${serviceName}`);

    // Auto-discover and store method metadata
    this.discoverServiceMethods(serviceName, service);

    // Auto-discover and store channel metadata
    this.discoverServiceChannels(serviceName, service);

    // Ensure connection handler is installed
    this.installConnectionHandler();
  }

  /**
   * Discover and store all public methods from a service.
   */
  private discoverServiceMethods(serviceName: string, service: BaseServiceInstance): void {
    const methods = service.getPublicMethods();

    for (const method of methods) {
      const eventName = `${serviceName}:${method.name}`;
      this.logger.info(`Registering socket event: ${eventName}`);

      // Store method metadata for deferred registration on connection
      this.methodRegistry.set(eventName, {
        serviceName,
        method,
        service,
      });
    }
  }

  /**
   * Discover and store all channels from a service.
   */
  private discoverServiceChannels(serviceName: string, service: BaseServiceInstance): void {
    const channels = service.getPublicChannels?.() ?? [];

    for (const channel of channels) {
      const eventName = channelEventName(serviceName, channel.name);
      this.logger.info(
        `Registering channel event: ${eventName} (${channel.ratePerSecond}/s, burst ${channel.burst})`,
      );

      this.channelRegistry.set(eventName, {
        serviceName,
        channel,
        service,
      });
    }
  }

  /**
   * Register a channel as a socket event listener.
   *
   * This is the hot path for high-frequency traffic: no ack, no async access
   * checks, no per-message logging. Order of operations per message:
   * token bucket → schema validation → in-memory access check → handler.
   * Any failure silently drops the message; sustained extreme flooding
   * disconnects the socket.
   */
  private registerChannelListener(
    socket: QuickdrawSocket,
    eventName: string,
    channel: ServiceChannelDefinition<unknown>,
    service: BaseServiceInstance,
  ): void {
    // Per-socket, per-channel token bucket state lives in this closure.
    let tokens = channel.burst;
    let lastRefillAt = Date.now();
    let abuseWindowStart = lastRefillAt;
    let droppedInWindow = 0;

    socket.on(eventName, (payload: unknown) => {
      const now = Date.now();

      // Refill continuously, capped at burst capacity
      tokens = Math.min(
        channel.burst,
        tokens + ((now - lastRefillAt) / 1000) * channel.ratePerSecond,
      );
      lastRefillAt = now;

      if (tokens < 1) {
        if (now - abuseWindowStart > CHANNEL_ABUSE_WINDOW_MS) {
          abuseWindowStart = now;
          droppedInWindow = 0;
        }
        droppedInWindow++;
        if (droppedInWindow > channel.ratePerSecond * CHANNEL_ABUSE_MULTIPLIER) {
          this.logger.warn(
            `Disconnecting socket ${socket.id} for sustained channel flooding on ${eventName}`,
            { userId: socket.userId, droppedInWindow },
          );
          socket.disconnect(true);
        }
        return;
      }
      tokens -= 1;

      const parsed = channel.schema.safeParse(payload);
      if (!parsed.success) return;

      if (!service.checkChannelAccess?.(channel, socket, parsed.data)) return;

      try {
        channel.handler(parsed.data, {
          userId: socket.userId!,
          socketId: socket.id,
          serviceAccess: socket.serviceAccess ?? {},
        });
      } catch (error) {
        this.logger.error(`Channel handler error for ${eventName}`, {
          userId: socket.userId,
          error: error instanceof Error ? error.message : "Unknown error",
        });
      }
    });
  }

  /**
   * Register a method as a socket event listener.
   */
  private registerMethodListener(
    socket: QuickdrawSocket,
    eventName: string,
    method: ServiceMethodDefinition<unknown, unknown>,
    service: BaseServiceInstance,
  ): void {
    socket.on(
      eventName,
      async (payload: unknown, callback?: (response: ServiceResponse<unknown>) => void) => {
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

          // Log start (if enabled)
          if (this.methodLoggingEnabled) {
            const logContext: Record<string, unknown> = {
              category: "request_processing",
              serviceName,
              methodName,
              userId: socket.userId,
              socketId: socket.id,
            };
            if (this.logPayloads) {
              logContext.payload = validatedPayload;
            }
            this.logger.info(
              `User ${userIdShort} ${serviceName}.${methodName} -> start`,
              logContext,
            );
          }

          // Execute handler
          const result = await method.handler(validatedPayload, {
            userId: socket.userId,
            socketId: socket.id,
            serviceAccess: socket.serviceAccess ?? {},
          });

          // Log success (if enabled)
          if (this.methodLoggingEnabled) {
            const durationMs = Date.now() - startedAt;
            const logContext: Record<string, unknown> = {
              category: "request_processing",
              outcome: "success",
              durationMs,
              serviceName,
              methodName,
              userId: socket.userId,
            };
            if (this.logResponses) {
              logContext.response = result;
            }
            this.logger.info(
              `User ${userIdShort} ${serviceName}.${methodName} -> success`,
              logContext,
            );
          }

          const successResponse: ServiceResponse<unknown> = {
            success: true,
            data: result,
          };
          callback?.(successResponse);
        } catch (error) {
          // Always log errors, even if methodLogging is disabled
          const durationMs = Date.now() - startedAt;
          const logContext: Record<string, unknown> = {
            category: "request_processing",
            outcome: "fail",
            durationMs,
            serviceName,
            methodName,
            userId: socket.userId,
            socketId: socket.id,
            error: error instanceof Error ? error.message : "Unknown error",
          };
          if (this.logPayloads) {
            logContext.payload = payload;
          }
          this.logger.error(`User ${userIdShort} ${serviceName}.${methodName} -> fail`, logContext);

          const errorResponse: ServiceResponse<unknown> = {
            success: false,
            error: error instanceof Error ? error.message : "Internal error",
            code: 500,
          };
          callback?.(errorResponse);
        }
      },
    );
  }

  /**
   * Register subscription listener for a service.
   */
  private registerSubscriptionListener(
    socket: QuickdrawSocket,
    eventName: string,
    service: BaseServiceInstance,
  ): void {
    socket.on(
      eventName,
      async (
        payload: { entryId: string; requiredLevel?: string },
        callback?: (response: ServiceResponse<unknown>) => void,
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
            (payload.requiredLevel as "Read" | "Moderate" | "Admin") ?? "Read",
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
      },
    );
  }

  /**
   * Register batch subscription listener for a service.
   * Handles subscribing to multiple entities in a single event.
   */
  private registerBatchSubscriptionListener(
    socket: QuickdrawSocket,
    eventName: string,
    service: BaseServiceInstance,
  ): void {
    socket.on(
      eventName,
      async (
        payload: { entryIds: string[]; requiredLevel?: string },
        callback?: (response: ServiceResponse<Record<string, unknown>>) => void,
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

          if (!Array.isArray(payload.entryIds) || payload.entryIds.length === 0) {
            callback?.({
              success: false,
              error: "entryIds must be a non-empty array",
              code: 400,
            });
            return;
          }

          const data = await service.batchSubscribe(
            payload.entryIds,
            socket,
            (payload.requiredLevel as "Read" | "Moderate" | "Admin") ?? "Read",
          );

          callback?.({ success: true, data });
        } catch (error) {
          this.logger.error(`Error in batch subscription ${eventName}:`, {
            error: error instanceof Error ? error.message : "Unknown error",
          });
          callback?.({
            success: false,
            error: error instanceof Error ? error.message : "Batch subscription failed",
          });
        }
      },
    );
  }

  /**
   * Register unsubscription listener for a service.
   */
  private registerUnsubscriptionListener(
    socket: QuickdrawSocket,
    eventName: string,
    service: BaseServiceInstance,
  ): void {
    socket.on(
      eventName,
      (
        payload: { entryId: string },
        callback?: (response: ServiceResponse<{ unsubscribed: true; entryId: string }>) => void,
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
      },
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
