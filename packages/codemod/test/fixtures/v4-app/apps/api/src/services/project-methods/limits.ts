import type { ProjectService } from "../project.js";

// A port declared as an interface over the class, taken through a type parameter
interface ProjectLimitsPort extends Pick<ProjectService, "defineMethod"> {}

export function registerProjectLimits<S extends ProjectLimitsPort>(service: S): void {
  service.defineMethod("getProjectLimits", "Read", async () => {
    return { maxProjects: 50, maxMembers: 200 };
  });
}
