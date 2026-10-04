import { labelService } from "./label.js";
import { projectService as projectServiceDef } from "./project.js";

/** Every service against the app's Prisma client, as the template's build-services.ts builds them. */
export function buildServices(): { projectService: typeof projectServiceDef; labelService: typeof labelService } {
  // quickdraw-migrate: review [server] the 4.x service was constructed here (new ProjectService(...)): it is the object projectServiceDef now; pass it in qd.createServer({ services: [...] })
  const projectService = projectServiceDef;
  return {
    projectService,
    // quickdraw-migrate: review [server] the 4.x service was constructed here (new LabelService(...)): it is the object labelService now; pass it in qd.createServer({ services: [...] })
    labelService: labelService,
  };
}

/** Takes the 4.x instance and calls one of its methods, as quickdraw-chat's push routes do. */
export function boardRoom(projectService: typeof projectServiceDef, projectId: string): string {
  // quickdraw-migrate: review [server] projectService is a 4.x ProjectService instance, whose members (getRoomName here) the service object projectService does not have: call a contract method through qd.caller(principal).projectService.<method>(input), and move other logic into a module of its own
  return projectService.getRoomName(projectId);
}
