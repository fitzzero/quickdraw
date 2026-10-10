import type { projectService } from "../project.js";
import type { MethodOf } from "../../quickdraw.js";
import type { projectContract } from "@project/shared";

// A port declared as an interface over the class, taken through a type parameter
// quickdraw-migrate: review [this] ProjectLimitsPort was a port of the 4.x ProjectService instance, the type its method modules took: those modules export method objects now, and the service object projectService has none of the instance's members. Delete it, or keep only what the helpers that still take it use
interface ProjectLimitsPort extends Pick<typeof projectService, "defineMethod"> { }

export const getProjectLimits = {
  // quickdraw-migrate: review [access] "Read" with no row id let every signed-in user call this in 4.x, and "authenticated" keeps that; narrow it ({ service: "Read" }, { entry: "Read", id } or a scope form) if that was not meant
  access: "authenticated",
  handler: async () => {
    return { maxProjects: 50, maxMembers: 200 };
  },
} satisfies MethodOf<typeof projectContract, "getProjectLimits">;
