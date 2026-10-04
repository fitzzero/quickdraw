import { resolver } from "@fitzzero/quickdraw-core/server";
import type { ParsedInputOf } from "@fitzzero/quickdraw-core";
import { qd } from "../quickdraw.js";
import { labelContract } from "@project/shared";

/** Labels have no row-level access: only service grants open them. */
export const labelService = qd.defineService(labelContract, {
  model: "label",
  // quickdraw-migrate: review [access] 4.x had no row-level access here (no hasEntryACL, no checkAccess): only service grants opened rows, which this empty policy keeps. Give it a real policy if rows belong to someone
  access: resolver({ levelsFor: () => ({}) }),
  methods: {
    getLabel: {
      access: { service: "Read", entry: "Read", id: "id" },
      handler: async ({ input, db }) => {
        return await db.label.findUnique({ where: { id: input.id } });
      },
    },
    renameLabel: {
      // quickdraw-migrate: review [access] 4.x's resolveEntryId was a function, kept here: where it returns nothing, the "" makes the row check fail, so only the service grant passes (4.x then applied the plain level)
      access: { service: "Moderate", entry: "Moderate", id: (input: ParsedInputOf<typeof labelContract, "renameLabel">) => ((p) => p.labelId ?? null)(input) ?? "" },
      handler: async ({ input: { labelId, name }, db }) => {
        return await db.label.update({ where: { id: labelId }, data: { name } });
      },
    },
    listLabels: {
      // quickdraw-migrate: review [access] "Read" with no row id let every signed-in user call this in 4.x, and "authenticated" keeps that; narrow it ({ service: "Read" }, { entry: "Read", id } or a scope form) if that was not meant
      access: "authenticated",
      handler: async ({ input, db }) =>
        await db.label.findMany({
          where: { projectId: input.projectId },
          orderBy: { name: "asc" },
          take: 500,
        }),
    },
    deleteAllLabels: {
      access: { service: "Admin" },
      handler: async ({ input, ctx, db }) => {
        const { count } = await db.label.deleteMany({
          where: { projectId: input.projectId },
        });
        ctx.log.info(`Deleted ${count} labels`, { userId: ctx.principal.userId, service: "labelService" });
        return { count };
      },
    },
  },
});
