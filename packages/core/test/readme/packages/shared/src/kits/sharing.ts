import { defineContract, sharing, via } from "@fitzzero/quickdraw-core";
import { z } from "zod";

const projectSchema = z.object({ id: z.string(), name: z.string() });

export const project = defineContract("projectService", {
  entity: projectSchema,
  methods: {
    // the JSON access list jsonAcl reads: share, unshare, setLevel, listShares
    ...sharing.contract({ mode: "acl" }),
    // the table members reads: invite, remove, leave, setRole, listMembers; by name too
    ...sharing.contract({
      mode: "members",
      methods: ["invite", "inviteByName", "remove", "leave", "setRole", "listMembers"],
    }),
  },
  collections: {
    // each user's projects: an invite adds the project, a remove or a leave takes it out
    mine: {
      scope: via({ model: "projectMember", entry: "projectId", scope: "userId" }),
      item: "entity",
      order: [["id", "asc"]],
    },
  },
});
