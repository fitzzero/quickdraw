import { anyOf, members, owner, sharing } from "@fitzzero/quickdraw-core/server";
import { projectContract } from "@project/shared";
import { qd } from "../quickdraw";

export const projectService = qd.defineService(projectContract, {
  model: "project",
  // the owner is Admin; members get the level their row's `role` names
  access: anyOf(
    owner("ownerId"),
    members({ model: "projectMember", entry: "projectId", user: "userId", level: "role" }),
  ),
  // the sharing kit's invites and removals
  writes: ["projectMember"],
  // a user opens only their own list
  collections: { mine: { scopeAccess: "self" } },
  methods: {
    get: {
      access: { entry: "Read" },
      handler: ({ input, db }) => db.project.findUniqueOrThrow({ where: { id: input.id } }),
    },
    ...sharing.handlers(projectContract),
  },
});
