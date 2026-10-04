import type { PrismaClient } from "@project/db";
import type { HealthServiceMethods } from "@project/shared";
import { BaseRpcService } from "@fitzzero/quickdraw-core/server";

/** Method-only service: no rows, no subscriptions. */
export class HealthService extends BaseRpcService<HealthServiceMethods> {
  constructor(private readonly prisma: PrismaClient) {
    super({ serviceName: "healthService" });

    this.defineMethod("ping", "Public", async () => {
      this.logger.debug("ping");
      return { ok: true as const, at: new Date().toISOString() };
    });

    this.defineMethod("stats", "Admin", async () => {
      const [projects, tasks] = await Promise.all([
        this.prisma.project.count(),
        this.prisma.task.count(),
      ]);
      return { projects, tasks };
    });
  }
}
