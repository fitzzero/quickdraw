import { projectContract } from "@project/shared";
import { task } from "../../../../../packages/shared/src/kits/search";
import { db } from "../../db";
import { qd } from "../../quickdraw";

// #region service
import { inherit, search } from "@fitzzero/quickdraw-core/server";

export const taskService = qd.defineService(task, {
  model: "task",
  access: inherit({ from: projectContract, via: "projectId" }),
  collections: { byProject: { anchor: projectContract } },
  methods: { ...search.handlers(task, { access: "authenticated" }) },
});
// #endregion

// #region fulltext
export const fullTextSearch = search.handlers(task, {
  access: "authenticated",
  strategy: {
    // Prisma cannot filter on a tsvector column: find the ids with SQL. Keep
    // to the caller's rows (here, their projects' tasks) before LIMIT, so
    // other users' matches never fill the 1,000; the kit's access filter
    // still applies to what comes back.
    where: async (q, ctx) => {
      const rows = await db.$queryRaw<{ id: string }[]>`
        SELECT t.id FROM "Task" t
        JOIN "ProjectMember" m ON m."projectId" = t."projectId"
        WHERE m."userId" = ${ctx.principal.userId}
          AND t."searchVector" @@ websearch_to_tsquery('english', ${q})
        LIMIT 1000`;
      return { id: { in: rows.map((row) => row.id) } };
    },
  },
});
// #endregion
