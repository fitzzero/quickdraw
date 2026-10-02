import { BaseService } from "@fitzzero/quickdraw-core/server";
import type { AccessLevel, ServiceMethodMap } from "@fitzzero/quickdraw-core";
import { z } from "zod";
import type { Prisma, Project } from "../../generated/prisma/client";
import type { Db } from "../db";

export type ProjectServiceMethods = ServiceMethodMap<{
  getProject: {
    payload: { id: string };
    response: Project | null;
  };
}>;

const getProjectSchema = z.object({ id: z.string() });

/**
 * Projects, with the 4.1 README's membership-table ACL ("Pattern 2"): access
 * to a project is the member's role in `ProjectMember`. TaskService reuses
 * `checkMembership` for its own checks, the way real 4.1 apps inherit access
 * from a parent row.
 */
export class ProjectService extends BaseService<
  Project,
  Prisma.ProjectCreateInput,
  Prisma.ProjectUpdateInput,
  ProjectServiceMethods
> {
  constructor(private readonly prisma: Db) {
    super({ serviceName: "projectService", hasEntryACL: true });
    this.setDelegate(prisma.project);

    this.defineMethod("getProject", "Read", async (payload) => await this.findById(payload.id), {
      schema: getProjectSchema,
    });
  }

  protected override async checkEntryACL(
    userId: string,
    projectId: string,
    requiredLevel: AccessLevel,
  ): Promise<boolean> {
    return await this.checkMembership(userId, projectId, requiredLevel);
  }

  public async checkMembership(
    userId: string,
    projectId: string,
    requiredLevel: AccessLevel,
  ): Promise<boolean> {
    const member = await this.prisma.projectMember.findUnique({
      where: { projectId_userId: { projectId, userId } },
    });
    if (!member) return false;
    return this.isLevelSufficient(member.role as AccessLevel, requiredLevel);
  }
}
