import { project } from "../../../../../packages/shared/src/kits/sharing";
import { db } from "../../db";
import { qd } from "../../quickdraw";

// #region service
import { anyOf, jsonAcl, members, sharing } from "@fitzzero/quickdraw-core/server";

export const projectService = qd.defineService(project, {
  model: "project",
  access: anyOf(
    jsonAcl("acl", { owner: "ownerId" }),
    members({ model: "projectMember", entry: "projectId", user: "userId", level: "role" }),
  ),
  collections: { mine: { scopeAccess: "self" } },
  methods: {
    ...sharing.handlers(project, {
      // finds the user inviteByName means; none is NOT_FOUND
      resolveUser: async ({ name, email }) =>
        (await db.user.findFirst({ where: name === undefined ? { email } : { name } }))?.id,
      // runs inside the change's transaction: its writes commit with it, a throw undoes it
      onChange: (change, ctx) => {
        ctx.log.info("sharing changed", { kind: change.kind, id: change.id, user: change.userId });
      },
    }),
  },
});
// #endregion
