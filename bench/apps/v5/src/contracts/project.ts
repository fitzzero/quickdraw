import { crud, defineContract } from "@fitzzero/quickdraw-core";
import { projectSchema } from "./schemas";

/** Projects: the board's anchor. Access to one is the member's role in `ProjectMember`. */
export const projectContract = defineContract("projectService", {
  describe: "Projects, each the anchor of one board.",
  entity: projectSchema,
  methods: {
    ...crud.contract({ entity: projectSchema, get: true }),
  },
});
