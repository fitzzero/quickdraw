// The 4.x task service the guide's sections take apart.

import type { Prisma, PrismaClient, Task } from "@project/db";
import type { TaskCollections, TaskDTO, TaskServiceMethods } from "@project/shared";
import { serviceRoom } from "@project/shared";
import type { AccessLevel, CollectionSnapshotPage } from "@fitzzero/quickdraw-core";
import { BaseService, type QuickdrawSocket } from "@fitzzero/quickdraw-core/server";
import { z } from "zod";

// #region class
export class TaskService extends BaseService<
  Task,
  Prisma.TaskUncheckedCreateInput,
  Prisma.TaskUpdateInput,
  TaskServiceMethods,
  Record<string, never>,
  TaskDTO,
  TaskCollections
> {
  constructor(private readonly prisma: PrismaClient) {
    super({ serviceName: "taskService", hasEntryACL: true });
    this.setDelegate(prisma.task);
    this.initMethods();
  }
  // #endregion

  // #region methods
  private initMethods(): void {
    this.defineMethod(
      "renameTask",
      "Moderate",
      async (payload, _ctx) => {
        const task = await this.update(payload.id, { title: payload.title });
        return task ? this.toDto(task) : null;
      },
      {
        schema: z.object({ id: z.string(), title: z.string().min(1) }),
        resolveEntryId: (p) => p.id,
      },
    );

    this.defineMethod("getTask", "Read", async (payload) => {
      const task = await this.prisma.task.findUnique({ where: { id: payload.id } });
      return task ? this.toDto(task) : null;
    });

    this.defineMethod("archiveAll", "Admin", async (payload) => {
      const { count } = await this.prisma.task.updateMany({
        where: { projectId: payload.projectId },
        data: { status: "archived" },
      });
      this.emitToRoom(serviceRoom("projectService", payload.projectId), "task:archived", {
        id: payload.projectId,
      });
      return { count };
    });

    this.verifyAllMethods(["renameTask", "getTask", "archiveAll"]);
  }
  // #endregion

  // #region projection
  protected override toDto(task: Task): TaskDTO {
    return {
      id: task.id,
      projectId: task.projectId,
      title: task.title,
      status: task.status,
      notes: task.notes,
      createdAt: task.createdAt.toISOString(),
    };
  }

  protected override getProtectedFields(): (keyof TaskDTO)[] {
    return ["notes"];
  }
  // #endregion

  // #region access
  // Row access is the caller's role on the task's project
  protected override async checkEntryACL(
    userId: string,
    taskId: string,
    requiredLevel: AccessLevel,
  ): Promise<boolean> {
    const task = await this.prisma.task.findUnique({
      where: { id: taskId },
      select: { project: { select: { members: { where: { userId }, select: { role: true } } } } },
    });
    const role = task?.project.members[0]?.role as AccessLevel | undefined;
    return role !== undefined && this.isLevelSufficient(role, requiredLevel);
  }

  protected override checkAccess(
    _userId: string,
    _entryId: string,
    _requiredLevel: AccessLevel,
    _socket: QuickdrawSocket,
  ): boolean {
    return false;
  }
  // #endregion

  // #region writes
  // Every write went through the CRUD trio, which emitted and ran the hooks
  public async moveTask(id: string, projectId: string): Promise<boolean> {
    const moved = await this.update(id, { project: { connect: { id: projectId } } });
    return moved !== null;
  }

  protected override async afterUpdate(_before: Task | null, after: Task): Promise<void> {
    await this.prisma.project.update({ where: { id: after.projectId }, data: {} });
  }

  // #endregion

  // #region emits
  public async touchTask(id: string): Promise<void> {
    const task = await this.prisma.task.update({ where: { id }, data: {} });
    this.emitUpdate(id, this.toDto(task));
    this.emitCollectionUpsert("byProject", task.projectId, this.toDto(task));
  }
  // #endregion

  // #region collection
  public registerBoard(): void {
    this.defineCollection("byProject", {
      resolveScopeId: (task) => task.projectId,
      checkScopeAccess: (userId, projectId) => this.isMember(userId, projectId),
      snapshot: (projectId, opts) => this.boardPage(projectId, opts),
    });
  }

  private async isMember(userId: string, projectId: string): Promise<boolean> {
    const member = await this.prisma.projectMember.findUnique({
      where: { projectId_userId: { projectId, userId } },
    });
    return member !== null;
  }

  private async boardPage(
    projectId: string,
    opts: { cursor: string | null; limit: number },
  ): Promise<CollectionSnapshotPage<TaskDTO>> {
    const rows = await this.prisma.task.findMany({
      where: { projectId },
      orderBy: { ordinal: "asc" },
      take: opts.limit,
    });
    return { items: rows.map((row) => this.toDto(row)), nextCursor: null, totalCount: rows.length };
  }
  // #endregion

  // #region admin
  public registerAdmin(): void {
    this.installAdminMethods({
      expose: { list: true, get: true, update: true },
      access: {
        list: "Admin",
        get: "Admin",
        create: "Admin",
        update: "Admin",
        delete: "Admin",
        setEntryACL: "Admin",
        getSubscribers: "Admin",
        reemit: "Admin",
        unsubscribeAll: "Admin",
      },
      displayName: "Tasks",
    });
  }
  // #endregion

  // #region kick
  public async removeFromBoard(projectId: string, userId: string): Promise<void> {
    await this.prisma.projectMember.delete({
      where: { projectId_userId: { projectId, userId } },
    });
    await this.kickFromCollection("byProject", projectId, userId);
  }
  // #endregion
}
