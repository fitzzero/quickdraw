import type { Prisma, PrismaClient, Task } from "@project/db";
import type { TaskCard, TaskCollections, TaskDTO, TaskServiceMethods } from "@project/shared";
import type { AccessLevel, CollectionSnapshotPage } from "@fitzzero/quickdraw-core";
import { BaseService } from "@fitzzero/quickdraw-core/server";

const LEVELS: AccessLevel[] = ["Public", "Read", "Moderate", "Admin"];

// services/task/service-core.ts: state, ACL overrides, helpers. No methods:
// the method modules register them on the concrete TaskService.
export abstract class TaskServiceCore extends BaseService<
  Task,
  Prisma.TaskUncheckedCreateInput,
  Prisma.TaskUpdateInput,
  TaskServiceMethods,
  Record<string, never>,
  TaskDTO,
  TaskCollections
> {
  constructor(public readonly prisma: PrismaClient) {
    super({ serviceName: "taskService", hasEntryACL: true });
    this.setDelegate(prisma.task);

    // A project's board: scope = the task's project id
    this.defineCollection("byProject", {
      resolveScopeId: (task) => task.projectId,
      checkScopeAccess: (userId, projectId) => this.checkProjectAccess(userId, projectId, "Read"),
      snapshot: (projectId, opts) => this.byProjectSnapshot(projectId, opts),
      toItem: (task) => this.toCard(task),
    });
  }

  // Task access is the caller's membership role on the task's project
  protected override async checkEntryACL(
    userId: string,
    taskId: string,
    requiredLevel: AccessLevel,
  ): Promise<boolean> {
    const task = await this.prisma.task.findUnique({
      where: { id: taskId },
      select: { projectId: true },
    });
    if (!task) return false;
    return await this.checkProjectAccess(userId, task.projectId, requiredLevel);
  }

  public async checkProjectAccess(
    userId: string,
    projectId: string,
    requiredLevel: AccessLevel,
  ): Promise<boolean> {
    const member = await this.prisma.projectMember.findUnique({
      where: { projectId_userId: { projectId, userId } },
      select: { role: true },
    });
    return member !== null && LEVELS.indexOf(member.role as AccessLevel) >= LEVELS.indexOf(requiredLevel);
  }

  public toTaskDto(task: Task): TaskDTO {
    return {
      id: task.id,
      projectId: task.projectId,
      title: task.title,
      status: task.status,
      ordinal: task.ordinal,
      assigneeId: task.assigneeId,
      notes: task.notes,
      createdAt: task.createdAt.toISOString(),
      updatedAt: task.updatedAt.toISOString(),
    };
  }

  public toCard(task: Task): TaskCard {
    return { id: task.id, title: task.title, status: task.status, ordinal: task.ordinal };
  }

  protected override toDto(task: Task): TaskDTO {
    return this.toTaskDto(task);
  }

  private async byProjectSnapshot(
    projectId: string,
    opts: { cursor: string | null; limit: number },
  ): Promise<CollectionSnapshotPage<TaskCard>> {
    const rows = await this.prisma.task.findMany({
      where: { projectId },
      orderBy: [{ ordinal: "asc" }, { id: "asc" }],
      take: opts.limit,
    });
    const totalCount = await this.prisma.task.count({ where: { projectId } });
    return { items: rows.map((row) => this.toCard(row)), nextCursor: null, totalCount };
  }
}
