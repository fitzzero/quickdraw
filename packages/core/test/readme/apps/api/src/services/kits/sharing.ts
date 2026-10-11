import { project } from "../../../../../packages/shared/src/kits/sharing";
import { db } from "../../db";
import { qd } from "../../quickdraw";
import { removeFromBoard } from "./rooms";

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
      // the one user a by-name call means, or null (NOT_FOUND): an email is unique
      // (and wins when both are given), a display name counts only when exactly
      // one user has it
      resolveUser: async ({ name, email }) => {
        if (email !== undefined) {
          return (await db.user.findUnique({ where: { email }, select: { id: true } }))?.id;
        }
        if (name === undefined) {
          return null;
        }
        const named = await db.user.findMany({ where: { name }, select: { id: true }, take: 2 });
        return named.length === 1 ? named[0]?.id : null;
      },
      // runs inside the change's transaction: its writes commit with it, a throw undoes it
      onChange: async (change, ctx) => {
        ctx.log.info("sharing changed", { kind: change.kind, id: change.id, user: change.userId });
        // the flush revokes their subscriptions, but rooms are the app's: a user whose entry or
        // membership is gone leaves the project's board on every node (removeFromBoard, rooms.ts)
        if (change.after === null) {
          await removeFromBoard(change.id, change.userId);
        }
      },
    }),
  },
});
// #endregion
