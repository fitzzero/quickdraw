import { prisma } from "@project/db";
import { LabelService } from "./label.js";
import { ProjectService } from "./project.js";

/** Every service against the app's Prisma client, as the template's build-services.ts builds them. */
export function buildServices(): { projectService: ProjectService; labelService: LabelService } {
  const projectService = new ProjectService(prisma);
  return {
    projectService,
    labelService: new LabelService(prisma),
  };
}

/** Takes the 4.x instance and calls one of its methods, as quickdraw-chat's push routes do. */
export function boardRoom(projectService: ProjectService, projectId: string): string {
  return projectService.getRoomName(projectId);
}
