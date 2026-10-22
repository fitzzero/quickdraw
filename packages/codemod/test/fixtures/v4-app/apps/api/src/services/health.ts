import type { PrismaClient } from "@project/db";
import type { HealthServiceMethods } from "@project/shared";
import { BaseRpcService } from "@fitzzero/quickdraw-core/server";
import { byIdSchema } from "./shared/schemas.js";

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

    // Whether a project exists: its schema is a shared helper, with no Zod of this file's own
    this.defineMethod(
      "getProjectHealth",
      "Admin",
      async (payload) => {
        const project = await this.prisma.project.findUnique({
          where: { id: payload.id },
          select: { id: true },
        });
        return { ok: project !== null };
      },
      { schema: byIdSchema },
    );
  }
}
