import type { Label, Prisma, PrismaClient } from "@project/db";
import type { LabelDTO, LabelServiceMethods } from "@project/shared";
import { BaseService, type QuickdrawSocket } from "@fitzzero/quickdraw-core/server";
import { z } from "zod";

/** Called with a label's id whenever one is renamed or created. */
export type LabelListener = (labelId: string) => void;

/** Labels have no row-level access: only service grants open them. */
export class LabelService extends BaseService<
  Label,
  Prisma.LabelUncheckedCreateInput,
  Prisma.LabelUpdateInput,
  LabelServiceMethods,
  Record<string, never>,
  LabelDTO
> {
  // Labels renamed since start-up, as quickdraw-chat's game keeps its players
  private readonly renamed = new Set<string>();
  // Set from the constructor's options, as quickdraw-chat's push service keeps its transport
  private readonly onChange: LabelListener | undefined;
  /** The room every label editor joins. */
  public readonly room: string;

  constructor(
    private readonly prisma: PrismaClient,
    options: { onChange?: LabelListener } = {},
  ) {
    super({ serviceName: "labelService" });
    this.setDelegate(prisma.label);
    this.onChange = options.onChange;
    this.room = this.getRoomName("all");

    this.defineMethod("getLabel", "Read", async (payload) => {
      return await this.prisma.label.findUnique({ where: { id: payload.id } });
    });

    // Anyone may read a label's name by its id: "Public" with an id and no schema
    this.defineMethod("getLabelName", "Public", async (payload) => {
      return await this.prisma.label.findUnique({
        where: { id: payload.id },
        select: { name: true },
      });
    });

    this.defineMethod(
      "renameLabel",
      "Moderate",
      async ({ labelId, name }) => {
        const label = await this.prisma.label.update({ where: { id: labelId }, data: { name } });
        this.renamed.add(label.id);
        this.onChange?.(label.id);
        return label;
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

  /** How many labels were renamed since start-up. */
  public get renamedCount(): number {
    return this.renamed.size;
  }

  /** The class's name, for logs: a member every object has, which the codemod must not take for one of its tables' keys. */
  public kind(): string {
    return this.constructor.name;
  }

  /** The label room and how many sockets are in it, for the admin page. */
  public roomStats(): { room: string; sockets: number } {
    const room = this.room;
    return { room, sockets: this.subscribers.get("all")?.size ?? 0 };
  }

  // The base class does the leaving; this only tells the listener
  public override unsubscribeSocket(socket: QuickdrawSocket): void {
    super.unsubscribeSocket(socket);
    this.onChange?.(`left:${socket.id}`);
  }

  // Admin creates tell the listener too, as quickdraw-chat's definitions do
  protected override async adminCreate(data: Prisma.LabelUncheckedCreateInput): Promise<Label> {
    const created = await super.adminCreate(data);
    this.onChange?.(created.id);
    return created;
  }

  // Deletes tell the listener too: 4.x's delete, whose name is a reserved word
  protected override async delete(id: string): Promise<boolean> {
    await this.prisma.label.delete({ where: { id } });
    this.onChange?.(id);
    return true;
  }

  /** Deletes a label for the admin page, through the override. */
  public async removeLabel(id: string): Promise<boolean> {
    return await this.delete(id);
  }
}
