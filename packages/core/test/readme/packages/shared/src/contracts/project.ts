import { defineContract, query, sharing, via } from "@fitzzero/quickdraw-core";
import { z } from "zod";
import { projectSchema } from "../schemas";

export const projectContract = defineContract("projectService", {
  entity: projectSchema,
  methods: {
    get: query({ input: z.object({ id: z.string() }), output: "entity" }),
    // invite, remove, leave, setRole, listMembers on the projectMember table
    ...sharing.contract({ mode: "members" }),
  },
  collections: {
    // each user's projects: an invite adds one, a remove or a leave takes it out
    mine: {
      scope: via({ model: "projectMember", entry: "projectId", scope: "userId" }),
      item: "entity",
      order: [["id", "asc"]],
    },
  },
});
