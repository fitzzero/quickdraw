import type { Label, Prisma, PrismaClient } from "@project/db";
import type { LabelDTO, LabelServiceMethods } from "@project/shared";
import { BaseService } from "@fitzzero/quickdraw-core/server";
import { z } from "zod";

/** Labels have no row-level access: only service grants open them. */
export class LabelService extends BaseService<
  Label,
  Prisma.LabelUncheckedCreateInput,
  Prisma.LabelUpdateInput,
  LabelServiceMethods,
  Record<string, never>,
  LabelDTO
> {
  constructor(private readonly prisma: PrismaClient) {
    super({ serviceName: "labelService" });
    this.setDelegate(prisma.label);

    this.defineMethod("getLabel", "Read", async (payload) => {
      return await this.prisma.label.findUnique({ where: { id: payload.id } });
    });

    this.defineMethod(
      "renameLabel",
      "Moderate",
      async ({ labelId, name }) => {
        return await this.prisma.label.update({ where: { id: labelId }, data: { name } });
      },
      { resolveEntryId: (p) => p.labelId ?? null },
    );

    this.defineMethod(
      "listLabels",
      "Read",
      async (payload) =>
        await this.prisma.label.findMany({
          where: { projectId: payload.projectId },
          orderBy: { name: "asc" },
          take: 500,
        }),
      { schema: z.object({ projectId: z.string() }) },
    );

    this.defineMethod("deleteAllLabels", "Admin", async (payload, ctx) => {
      const { count } = await this.prisma.label.deleteMany({
        where: { projectId: payload.projectId },
      });
      this.logger.info(`Deleted ${count} labels`, { userId: ctx.userId, service: this.serviceName });
      return { count };
    });
  }
}
