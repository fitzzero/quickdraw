import { BaseService } from "@fitzzero/quickdraw-core/server";
import type {
  AccessLevel,
  CollectionSnapshotPage,
  ServiceMethodMap,
} from "@fitzzero/quickdraw-core";
import { z } from "zod";
import type { Prisma, Task } from "../../generated/prisma/client";
import type { Db } from "../db";
import type { ProjectService } from "./ProjectService";

/** Board columns, in order; Cancelled cards are never shown. */
export const BOARD_STATUSES = [
  "Planning",
  "Open",
  "InProgress",
  "ReviewPR",
  "ReviewDev",
  "Complete",
] as const;
const TASK_STATUSES = [...BOARD_STATUSES, "Cancelled"] as const;
/** Cards per column on the first board load (Conveyor's board uses 20). */
export const BOARD_PAGE_SIZE = 20;

/** The collection item: what a card on the board needs, without the plan. */
export type TaskCard = Pick<
  Task,
  "id" | "projectId" | "status" | "ordinal" | "title" | "assigneeId" | "updatedAt"
>;

export interface TasksByStatus {
  status: string;
  tasks: Task[];
  totalCount: number;
}

export type TaskServiceMethods = ServiceMethodMap<{
  getTasksByStatus: {
    payload: { projectId: string };
    response: TasksByStatus[];
  };
  updateTask: {
    payload: {
      id: string;
      title?: string;
      status?: string;
      ordinal?: number;
      assigneeId?: string | null;
    };
    response: Task;
  };
}>;

type TaskCollections = { cardsByProject: { item: TaskCard } };

const getTasksByStatusSchema = z.object({ projectId: z.string() });

const updateTaskSchema = z.object({
  id: z.string(),
  title: z.string().min(1).max(500).optional(),
  status: z.enum(TASK_STATUSES).optional(),
  ordinal: z.number().int().min(0).optional(),
  assigneeId: z.string().nullable().optional(),
});

const CARD_SELECT = {
  id: true,
  projectId: true,
  status: true,
  ordinal: true,
  title: true,
  assigneeId: true,
  updatedAt: true,
} satisfies Prisma.TaskSelect;

const CARD_ORDER: Prisma.TaskOrderByWithRelationInput[] = [{ ordinal: "asc" }, { id: "asc" }];

export function toTaskCard(task: Task): TaskCard {
  return {
    id: task.id,
    projectId: task.projectId,
    status: task.status,
    ordinal: task.ordinal,
    title: task.title,
    assigneeId: task.assigneeId,
    updatedAt: task.updatedAt,
  };
}

/**
 * Tasks, written the way the 4.1 README teaches: a `cardsByProject`
 * collection, a board query that returns full rows grouped by status, and a
 * mutation that writes through raw Prisma and then emits by hand (the pattern
 * behind most real 4.1 writes, per RFC 0003 audit section 2.1). Entity access
 * is inherited from the project through `checkEntryACL`; batch subscribe uses
 * BaseService's defaults, which the README never asks an app to override.
 */
export class TaskService extends BaseService<
  Task,
  Prisma.TaskCreateInput,
  Prisma.TaskUpdateInput,
  TaskServiceMethods,
  Record<string, unknown>,
  Task,
  TaskCollections
> {
  constructor(
    private readonly prisma: Db,
    private readonly projects: ProjectService,
  ) {
    super({ serviceName: "taskService", hasEntryACL: true });
    this.setDelegate(prisma.task);

    this.defineCollection("cardsByProject", {
      resolveScopeId: (task) => task.projectId,
      checkScopeAccess: async (userId, projectId) =>
        await this.projects.checkMembership(userId, projectId, "Read"),
      snapshot: async (projectId, { cursor, limit }) =>
        await this.getCardPage(projectId, cursor, limit),
      toItem: (task) => toTaskCard(task),
    });

    this.defineMethod(
      "getTasksByStatus",
      "Read",
      async (payload, ctx) => {
        const allowed =
          ctx.userId !== undefined &&
          (await this.projects.checkMembership(ctx.userId, payload.projectId, "Read"));
        if (!allowed) throw new Error("Access denied to project");
        return await this.getTasksByStatus(payload.projectId);
      },
      { schema: getTasksByStatusSchema },
    );

    this.defineMethod(
      "updateTask",
      "Moderate",
      async ({ id, ...changes }) => {
        const task = await this.prisma.task.update({ where: { id }, data: changes });
        this.emitUpdate(task.id, task);
        this.emitCollectionUpsert("cardsByProject", task.projectId, toTaskCard(task));
        return task;
      },
      { schema: updateTaskSchema },
    );
  }

  /** A task's access is its project's: look up the project, then the membership. */
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
    return await this.projects.checkMembership(userId, task.projectId, requiredLevel);
  }

  private async getTasksByStatus(projectId: string): Promise<TasksByStatus[]> {
    return await Promise.all(
      BOARD_STATUSES.map(async (status) => {
        const where = { projectId, status };
        const [tasks, totalCount] = await Promise.all([
          this.prisma.task.findMany({
            where,
            orderBy: CARD_ORDER,
            take: BOARD_PAGE_SIZE,
          }),
          this.prisma.task.count({ where }),
        ]);
        return { status, tasks, totalCount };
      }),
    );
  }

  private async getCardPage(
    projectId: string,
    cursor: string | null,
    limit: number,
  ): Promise<CollectionSnapshotPage<TaskCard>> {
    const where = { projectId };
    const [rows, totalCount, idRows] = await Promise.all([
      this.prisma.task.findMany({
        where,
        orderBy: CARD_ORDER,
        take: limit + 1,
        ...(cursor === null ? {} : { cursor: { id: cursor }, skip: 1 }),
        select: CARD_SELECT,
      }),
      this.prisma.task.count({ where }),
      cursor === null
        ? this.prisma.task.findMany({ where, orderBy: CARD_ORDER, select: { id: true } })
        : Promise.resolve(null),
    ]);
    const items = rows.slice(0, limit);
    const last = items.at(-1);
    return {
      items,
      nextCursor: rows.length > limit && last ? last.id : null,
      totalCount,
      ...(idRows === null ? {} : { ids: idRows.map((row) => row.id) }),
    };
  }
}
