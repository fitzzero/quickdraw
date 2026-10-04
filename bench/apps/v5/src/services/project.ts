import { crud, members } from "@fitzzero/quickdraw-core/server";
import { projectContract } from "../contracts";
import { qd } from "../quickdraw";

/**
 * Projects. A member's level on a project is the role in their
 * `ProjectMember` row ("Read" | "Moderate" | "Admin"), the 4.1 app's
 * membership-table pattern as a policy.
 */
export const projectService = qd.defineService(projectContract, {
  model: "project",
  access: members({ model: "projectMember", entry: "projectId", user: "userId", level: "role" }),
  methods: {
    ...crud.handlers(projectContract, { access: { get: { entry: "Read" } } }),
  },
});
