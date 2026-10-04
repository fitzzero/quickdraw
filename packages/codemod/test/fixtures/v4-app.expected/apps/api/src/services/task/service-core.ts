import type { Task } from "@project/db";
import type { TaskCard, TaskDTO } from "@project/shared";
// quickdraw-migrate: review [v4-api] 4.x API CollectionSnapshotPage (removed): lint's no-v4-api names each replacement
import type { AccessLevel, CollectionSnapshotPage } from "@fitzzero/quickdraw-core";
import { db } from "../../db.js";

const LEVELS: AccessLevel[] = ["Public", "Read", "Moderate", "Admin"];

// services/task/service-core.ts: state, ACL overrides, helpers. No methods:
// the method modules register them on the concrete TaskService.

// A project's board: scope = the task's project id
// quickdraw-migrate: review [collection] 4.x collection "byProject": declare it in the contract's collections (scope, item, order) and anchor it in defineService's collections, then delete this; it is no longer used
const byProjectCollection = {
  resolveScopeId: (task) => task.projectId,
  checkScopeAccess: (userId, projectId) => checkProjectAccess(userId, projectId, "Read"),
  snapshot: (projectId, opts) => byProjectSnapshot(projectId, opts),
  toItem: (task) => toCard(task),
};

// Task access is the caller's membership role on the task's project
// quickdraw-migrate: review [access-override] 4.x access override: port it to the service's access policy (owner, jsonAcl, members, inherit, anyOf or resolver), then delete this function
async function checkEntryACL(userId: string, taskId: string, requiredLevel: AccessLevel): Promise<boolean> {
  const task = await db.task.findUnique({
    where: { id: taskId },
    select: { projectId: true },
  });
  if (!task) return false;
  return await checkProjectAccess(userId, task.projectId, requiredLevel);
}

export async function checkProjectAccess(userId: string, projectId: string, requiredLevel: AccessLevel): Promise<boolean> {
  const member = await db.projectMember.findUnique({
    where: { projectId_userId: { projectId, userId } },
    select: { role: true },
  });
  return member !== null && LEVELS.indexOf(member.role as AccessLevel) >= LEVELS.indexOf(requiredLevel);
}

export function toTaskDto(task: Task): TaskDTO {
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

export function toCard(task: Task): TaskCard {
  return { id: task.id, title: task.title, status: task.status, ordinal: task.ordinal };
}

// quickdraw-migrate: review [projection] 4.x toDto: subscribers now receive the contract entity's keys, projected from the row (dates as ISO strings); fold computed fields into a projection's select and map, then delete this function
function toDto(task: Task): TaskDTO {
  return toTaskDto(task);
}

async function byProjectSnapshot(projectId: string, opts: { cursor: string | null; limit: number }): Promise<CollectionSnapshotPage<TaskCard>> {
  const rows = await db.task.findMany({
    where: { projectId },
    orderBy: [{ ordinal: "asc" }, { id: "asc" }],
    take: opts.limit,
  });
  const totalCount = await db.task.count({ where: { projectId } });
  return { items: rows.map((row) => toCard(row)), nextCursor: null, totalCount };
}
