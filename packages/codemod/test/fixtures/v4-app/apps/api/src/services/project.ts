import type { Prisma, PrismaClient, Project } from "@project/db";
import type {
  ProjectCollections,
  ProjectDTO,
  ProjectListItem,
  ProjectServiceMethods,
} from "@project/shared";
import { serviceRoom } from "@project/shared";
import { BaseService } from "@fitzzero/quickdraw-core/server";
import type { ACL, AccessLevel, CollectionSnapshotPage } from "@fitzzero/quickdraw-core";
import { z } from "zod";
import { byIdSchema, cuidSchema, paginationSchema } from "./shared/schemas.js";
import { requireAuth } from "./shared/guards.js";

const createProjectSchema = z.object({
  name: z.string().min(1, "Name is required").max(100),
});

const shareProjectSchema = z.object({
  id: cuidSchema("project ID"),
  userId: cuidSchema("user ID"),
  level: z.enum(["Read", "Moderate", "Admin"]),
});

// Admin schema - defines fields available for admin CRUD
const adminProjectSchema = z.object({
  name: z.string(),
  ownerId: z.string(),
});

/**
 * Projects use the built-in JSON ACL: `hasEntryACL: true` reads the row's
 * `acl` column ([{ userId, level }]) when a method names a project.
 */
export class ProjectService extends BaseService<
  Project,
  Prisma.ProjectUncheckedCreateInput,
  Prisma.ProjectUpdateInput,
  ProjectServiceMethods,
  Record<string, never>,
  ProjectDTO,
  ProjectCollections
> {
  private readonly prisma: PrismaClient;

  constructor(prisma: PrismaClient) {
    super({ serviceName: "projectService", hasEntryACL: true });
    this.prisma = prisma;
    this.setDelegate(prisma.project);

    // The live list of a user's own projects. Scope = the owner's user id.
    this.defineCollection("mine", {
      resolveScopeId: (project) => project.ownerId,
      checkScopeAccess: (userId, scopeId) => userId === scopeId,
      snapshot: (scopeId, opts) => this.mineSnapshot(scopeId, opts),
      toItem: (project) => ({ id: project.id, name: project.name }),
    });

    this.initMethods();

    this.installAdminMethods({
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
    });
  }

  // Wire shape: the typed ACL (what SubscriptionDataMap advertises)
  protected override toDto(project: Project): ProjectDTO {
    return {
      id: project.id,
      name: project.name,
      ownerId: project.ownerId,
      acl: project.acl as ACL | null,
      archived: project.archived,
    };
  }

  // Only elevated subscribers see who a project is shared with
  protected override getProtectedFields(): (keyof ProjectDTO)[] {
    return ["acl"];
  }

  // A new project lands in its owner's `mine` list
  protected override async afterCreate(project: Project): Promise<void> {
    this.emitCollectionUpsert("mine", project.ownerId, { id: project.id, name: project.name });
  }

  private async mineSnapshot(
    ownerId: string,
    opts: { cursor: string | null; limit: number },
  ): Promise<CollectionSnapshotPage<ProjectListItem>> {
    const rows = await this.prisma.project.findMany({
      where: { ownerId },
      orderBy: { id: "asc" },
      take: opts.limit + 1,
      ...(opts.cursor ? { cursor: { id: opts.cursor }, skip: 1 } : {}),
    });
    const page = rows.slice(0, opts.limit);
    return {
      items: page.map((row) => ({ id: row.id, name: row.name })),
      nextCursor: rows.length > opts.limit ? (page.at(-1)?.id ?? null) : null,
      totalCount: await this.prisma.project.count({ where: { ownerId } }),
    };
  }

  private initMethods(): void {
    this.initCrudMethods();
    this.initSharingMethods();
    // Fail fast at construction if the method map and definitions drift
    this.verifyAllMethods([
      "createProject",
      "getProject",
      "renameProject",
      "listMyProjects",
      "getMembers",
      "shareProject",
      "archiveProject",
      "deleteProject",
    ]);
  }

  private initCrudMethods(): void {
    // Create a project: the CRUD trio emits the entity and runs afterCreate
    this.defineMethod(
      "createProject",
      "Read",
      async (payload, ctx) => {
        requireAuth(ctx);
        const project = await this.create({
          name: payload.name,
          ownerId: ctx.userId,
          acl: [{ userId: ctx.userId, level: "Admin" }],
        });
        return { id: project.id };
      },
      { schema: createProjectSchema },
    );

    this.defineMethod(
      "getProject",
      "Read",
      async (payload, _ctx) => {
        const project = await this.prisma.project.findUnique({ where: { id: payload.id } });
        if (!project) return null;
        return this.toDto(project);
      },
      { schema: byIdSchema },
    );

    this.defineMethod(
      "renameProject",
      "Moderate",
      async (payload, _ctx) => {
        const updated = await this.update(payload.id, { name: payload.name });
        return updated ? this.toDto(updated) : null;
      },
      {
        schema: z.object({ id: cuidSchema("project ID"), name: z.string().min(1).max(100) }),
        resolveEntryId: (p) => p.id,
      },
    );

    this.defineMethod(
      "listMyProjects",
      "Read",
      async (payload, ctx) => {
        requireAuth(ctx);
        const pageSize = payload.pageSize ?? 20;
        const projects = await this.prisma.project.findMany({
          where: { ownerId: ctx.userId },
          orderBy: { name: "asc" },
          skip: ((payload.page ?? 1) - 1) * pageSize,
          take: pageSize,
        });
        return projects.map((project) => this.toDto(project));
      },
      { schema: paginationSchema },
    );

    // Archive: tell everyone watching the project room
    this.defineMethod("archiveProject", "Moderate", async (payload, _ctx) => {
      await this.update(payload.id, { archived: true });
      this.emitToRoom(serviceRoom("projectService", payload.id), "project:archived", {
        id: payload.id,
      });
      return { id: payload.id, archived: true as const };
    });

    this.defineMethod(
      "deleteProject",
      "Admin",
      async (payload, ctx) => {
        const deleted = await this.delete(payload.id);
        if (!deleted) throw new Error("Project not found");
        if (ctx.userId) {
          this.emitCollectionRemove("mine", ctx.userId, payload.id);
        }
        return { id: payload.id, deleted: true as const };
      },
      { schema: byIdSchema },
    );
  }

  private initSharingMethods(): void {
    this.defineMethod(
      "getMembers",
      "Read",
      async (payload, _ctx) => {
        const members = await this.prisma.projectMember.findMany({
          where: { projectId: payload.projectId },
          orderBy: { id: "asc" },
          take: 200,
        });
        return members.map((member) => ({
          id: member.id,
          userId: member.userId,
          role: member.role as AccessLevel,
        }));
      },
      {
        schema: z.object({ projectId: cuidSchema("project ID") }),
        resolveEntryId: (p) => p.projectId,
      },
    );

    // Share a project (add to its ACL) inside a transaction
    this.defineMethod(
      "shareProject",
      "Admin",
      async (payload, _ctx) => {
        await this.prisma.$transaction(async (tx) => {
          const project = await tx.project.findUnique({
            where: { id: payload.id },
            select: { acl: true },
          });
          if (!project) throw new Error("Project not found");
          const acl = ((project.acl as unknown as ACL) ?? []).filter(
            (entry) => entry.userId !== payload.userId,
          );
          acl.push({ userId: payload.userId, level: payload.level });
          await tx.project.update({
            where: { id: payload.id },
            data: { acl: acl as unknown as Prisma.InputJsonValue },
          });
        });
        return { id: payload.id };
      },
      { schema: shareProjectSchema },
    );
  }
}
