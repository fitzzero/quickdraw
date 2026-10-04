import type { Prisma, Project } from "@project/db";
import type {
  ProjectDTO,
  ProjectListItem
} from "@project/shared";
import { serviceRoom, projectContract } from "@project/shared";
import { jsonAcl } from "@fitzzero/quickdraw-core/server";
// quickdraw-migrate: review [v4-api] 4.x API CollectionSnapshotPage (removed): lint's no-v4-api names each replacement
import type { ACL, AccessLevel, CollectionSnapshotPage } from "@fitzzero/quickdraw-core";
import { z } from "zod";
import { qd } from "../quickdraw.js";
import { db } from "../db.js";

// Admin schema - defines fields available for admin CRUD
const adminProjectSchema = z.object({
  name: z.string(),
  ownerId: z.string(),
});

// The live list of a user's own projects. Scope = the owner's user id.
// quickdraw-migrate: review [collection] 4.x collection "mine": declare it in the contract's collections (scope, item, order) and anchor it in defineService's collections, then delete this; it is no longer used
const mineCollection = {
  resolveScopeId: (project) => project.ownerId,
  checkScopeAccess: (userId, scopeId) => userId === scopeId,
  snapshot: (scopeId, opts) => mineSnapshot(scopeId, opts),
  toItem: (project) => ({ id: project.id, name: project.name }),
};

// quickdraw-migrate: review [admin] installAdminMethods: use the admin kit (...admin.contract({ entity }) in the contract, ...admin.handlers(contract, { displayName, hiddenFields, fieldOverrides }) in methods), then delete this; it is no longer used
const adminMethods = {
  expose: { list: true, get: true, create: true, update: true, delete: true },
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
  schema: adminProjectSchema,
  displayName: "Projects",
  tableColumns: ["id", "name", "ownerId"],
};

// Wire shape: the typed ACL (what SubscriptionDataMap advertises)
// quickdraw-migrate: review [projection] 4.x toDto: subscribers now receive the contract entity's keys, projected from the row (dates as ISO strings); fold computed fields into a projection's select and map, then delete this function
function toDto(project: Project): ProjectDTO {
  return {
    id: project.id,
    name: project.name,
    ownerId: project.ownerId,
    acl: project.acl as ACL | null,
    archived: project.archived,
  };
}

// Only elevated subscribers see who a project is shared with
// quickdraw-migrate: review [projection] protected fields: declare them in the contract's fields with the level that may read each one (fields: { email: "Admin" }), then delete this function
function getProtectedFields(): (keyof ProjectDTO)[] {
  return ["acl"];
}

// A new project lands in its owner's `mine` list
// quickdraw-migrate: review [lifecycle] 4.x lifecycle hook, run only by this.create: move what it does into the methods that create rows (or affects, for rows of other services), then delete it
async function afterCreate(project: Project): Promise<void> {
  // quickdraw-migrate: review [emit] hand emit: 5.0 sends collection deltas from tracked writes; write through db and let the tracked write emit, then delete this hand emit once the collection is declared in the contract
  this.emitCollectionUpsert("mine", project.ownerId, { id: project.id, name: project.name });
}

async function mineSnapshot(ownerId: string, opts: { cursor: string | null; limit: number }): Promise<CollectionSnapshotPage<ProjectListItem>> {
  const rows = await db.project.findMany({
    where: { ownerId },
    orderBy: { id: "asc" },
    take: opts.limit + 1,
    ...(opts.cursor ? { cursor: { id: opts.cursor }, skip: 1 } : {}),
  });
  const page = rows.slice(0, opts.limit);
  return {
    items: page.map((row) => ({ id: row.id, name: row.name })),
    nextCursor: rows.length > opts.limit ? (page.at(-1)?.id ?? null) : null,
    totalCount: await db.project.count({ where: { ownerId } }),
  };
}

/**
 * Projects use the built-in JSON ACL: `hasEntryACL: true` reads the row's
 * `acl` column ([{ userId, level }]) when a method names a project.
 */
export const projectService = qd.defineService(projectContract, {
  model: "project",
  // 4.x's hasEntryACL read the row's `acl` column ([{ userId, level }]).
  access: jsonAcl("acl"),
  methods: {
    createProject: {
      // quickdraw-migrate: review [access] "Read" with no row id let every signed-in user call this in 4.x, and "authenticated" keeps that; narrow it ({ service: "Read" }, { entry: "Read", id } or a scope form) if that was not meant
      access: "authenticated",
      handler: async ({ input, ctx }) => {
        // quickdraw-migrate: review [write] 4.x CRUD helper this.create: it also emitted the entity and collection deltas and ran the lifecycle hooks. Write db.project.create(...) instead (frames follow the tracked write; hooks do not run; db.create throws on failure)
        const project = await this.create({
          name: input.name,
          ownerId: ctx.principal.userId,
          acl: [{ userId: ctx.principal.userId, level: "Admin" }],
        });
        return { id: project.id };
      },
    },
    getProject: {
      access: { service: "Read", entry: "Read", id: "id" },
      handler: async ({ input, db }) => {
        const project = await db.project.findUnique({ where: { id: input.id } });
        if (!project) return null;
        return toDto(project);
      },
    },
    renameProject: {
      access: { service: "Moderate", entry: "Moderate", id: "id" },
      handler: async ({ input }) => {
        // quickdraw-migrate: review [write] 4.x CRUD helper this.update: it also emitted the entity and collection deltas and ran the lifecycle hooks. Write db.project.update(...) instead (frames follow the tracked write; hooks do not run; 4.x returned null for a missing row where db.update throws NOT_FOUND)
        const updated = await this.update(input.id, { name: input.name });
        return updated ? toDto(updated) : null;
      },
    },
    listMyProjects: {
      // quickdraw-migrate: review [access] "Read" with no row id let every signed-in user call this in 4.x, and "authenticated" keeps that; narrow it ({ service: "Read" }, { entry: "Read", id } or a scope form) if that was not meant
      access: "authenticated",
      handler: async ({ input, ctx, db }) => {
        const pageSize = input.pageSize ?? 20;
        const projects = await db.project.findMany({
          where: { ownerId: ctx.principal.userId },
          orderBy: { name: "asc" },
          skip: ((input.page ?? 1) - 1) * pageSize,
          take: pageSize,
        });
        return projects.map((project) => toDto(project));
      },
    },
    archiveProject: {
      access: { service: "Moderate", entry: "Moderate", id: "id" },
      handler: async ({ input }) => {
        // quickdraw-migrate: review [write] 4.x CRUD helper this.update: it also emitted the entity and collection deltas and ran the lifecycle hooks. Write db.project.update(...) instead (frames follow the tracked write; hooks do not run; 4.x returned null for a missing row where db.update throws NOT_FOUND)
        await this.update(input.id, { archived: true });
        // quickdraw-migrate: review [emit] room event: declare it in the contract's events and send it with ctx.rooms.emit(room, contract, event, payload)
        this.emitToRoom(serviceRoom("projectService", input.id), "project:archived", {
          id: input.id,
        });
        return { id: input.id, archived: true as const };
      },
    },
    deleteProject: {
      access: { service: "Admin", entry: "Admin", id: "id" },
      handler: async ({ input, ctx }) => {
        // quickdraw-migrate: review [write] 4.x CRUD helper this.delete: it also emitted the entity and collection deltas and ran the lifecycle hooks. Write db.project.delete(...) instead (frames follow the tracked write; hooks do not run; 4.x returned false for a missing row where db.delete throws NOT_FOUND)
        const deleted = await this.delete(input.id);
        if (!deleted) throw new Error("Project not found");
        if (ctx.principal.userId) {
          // quickdraw-migrate: review [emit] hand emit: 5.0 sends collection deltas from tracked writes; write through db and let the tracked write emit, then delete this hand emit once the collection is declared in the contract
          this.emitCollectionRemove("mine", ctx.principal.userId, input.id);
        }
        return { id: input.id, deleted: true as const };
      },
    },
    getMembers: {
      access: { service: "Read", entry: "Read", id: "projectId" },
      handler: async ({ input, db }) => {
        const members = await db.projectMember.findMany({
          where: { projectId: input.projectId },
          orderBy: { id: "asc" },
          take: 200,
        });
        return members.map((member) => ({
          id: member.id,
          userId: member.userId,
          role: member.role as AccessLevel,
        }));
      },
    },
    shareProject: {
      access: { service: "Admin", entry: "Admin", id: "id" },
      handler: async ({ input, db }) => {
        await db.$transaction(async (tx) => {
          const project = await tx.project.findUnique({
            where: { id: input.id },
            select: { acl: true },
          });
          if (!project) throw new Error("Project not found");
          const acl = ((project.acl as unknown as ACL) ?? []).filter(
            (entry) => entry.userId !== input.userId,
          );
          acl.push({ userId: input.userId, level: input.level });
          await tx.project.update({
            where: { id: input.id },
            data: { acl: acl as unknown as Prisma.InputJsonValue },
          });
        });
        return { id: input.id };
      },
    },
  },
});
