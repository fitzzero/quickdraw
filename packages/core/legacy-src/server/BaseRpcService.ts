import { BaseService } from "./BaseService";

/**
 * Base class for delegate-less, method-only services — methods, channels,
 * ACL, and logging without a Prisma delegate, CRUD, or entity subscriptions.
 *
 * Use for services that orchestrate rather than own rows: build/deploy
 * triggers, external API bridges, health/vibe checks. Replaces the
 * `BaseService<never, never, never, TMethods>` contortion.
 *
 * Entity subscribe/batchSubscribe resolve to null/empty (there are no
 * entities), and the inherited CRUD trio throws if reached (no delegate).
 * Room emits (`emitToRoom`, `emitToUserRoom`, volatile) work as usual.
 *
 * @example
 * ```typescript
 * class CloudBuildService extends BaseRpcService<CloudBuildMethods> {
 *   constructor() {
 *     super({ serviceName: "cloudBuildService" });
 *     this.defineMethod("triggerBuild", "Moderate", async (payload, ctx) => {
 *       return await this.startBuild(payload.ref, ctx.userId);
 *     });
 *   }
 * }
 * ```
 */
export abstract class BaseRpcService<
  TServiceMethods extends {
    [K in keyof TServiceMethods]: { payload: unknown; response: unknown };
  } = Record<string, { payload: unknown; response: unknown }>,
  TChannels extends { [K in keyof TChannels]: unknown } = Record<string, unknown>,
> extends BaseService<
  { id: string },
  Record<string, unknown>,
  Record<string, unknown>,
  TServiceMethods,
  TChannels
> {
  /** RPC services have no entities to subscribe to. */
  public override async subscribe(): Promise<null> {
    return null;
  }

  /** RPC services have no entities to subscribe to. */
  public override async batchSubscribe(): Promise<Record<string, null>> {
    return {};
  }
}
