import { defineContract, query, sharing, via } from "@fitzzero/quickdraw-core";
import { z } from "zod";
import { projectSchema } from "../schemas";

export const projectContract = defineContract("projectService", {
  describe: "Projects and the people who are members of them.",
  entity: projectSchema,
  methods: {
    get: query({
      input: z.object({ id: z.string() }),
      output: "entity",
      describe: "Reads one project by its id.",
    }),
    // invite, remove, leave, setRole, listMembers on the projectMember table
    ...sharing.contract({ mode: "members" }),
  },
  collections: {
    // each user's projects: an invite adds one, a remove or a leave takes it out
    mine: {
      describe: "The projects a user is a member of.",
      scope: via({ model: "projectMember", entry: "projectId", scope: "userId" }),
      item: "entity",
      order: [["id", "asc"]],
    },
  },
});
