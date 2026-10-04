// MIGRATION.md's boards section: the board the benchmark's 5.0 app ported
// from 4.1 as written (bench/apps/v5), one fat query refetched on every change.

import { defineContract, query } from "@fitzzero/quickdraw-core";
import { projectContract } from "@project/shared";
import { z } from "zod";
import { qd } from "../../quickdraw";

const card = z.object({
  id: z.string(),
  title: z.string(),
  status: z.string(),
  ordinal: z.number(),
});

// #region fat
export const boardContract = defineContract("taskService", {
  entity: card.extend({ projectId: z.string() }),
  methods: {
    // every task of the project, grouped by status, fetched again after every write
    getTasksByStatus: query({
      input: z.object({ projectId: z.string() }),
      output: z.record(z.string(), z.array(card)),
      watch: { collection: "board", scope: (input) => input.projectId },
    }),
  },
  collections: {
    board: {
      scope: "projectId",
      item: "entity",
      order: [
        ["ordinal", "asc"],
        ["id", "asc"],
      ],
    },
  },
});

export const boardService = qd.defineService(boardContract, {
  model: "task",
  collections: { board: { anchor: projectContract } },
  methods: {
    getTasksByStatus: {
      access: { scope: "Read", of: projectContract, id: "projectId" },
      share: "all",
      handler: async ({ input, db }) => {
        const tasks = await db.task.findMany({
          where: { projectId: input.projectId },
          orderBy: { ordinal: "asc" },
          take: 5_000,
        });
        const byStatus: Record<string, typeof tasks> = {};
        for (const task of tasks) {
          (byStatus[task.status] ??= []).push(task);
        }
        return byStatus;
      },
    },
  },
});
// #endregion
