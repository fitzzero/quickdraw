import { crud, inherit } from "@fitzzero/quickdraw-core/server";
import { BOARD_PAGE_SIZE, BOARD_STATUSES, projectContract, taskContract } from "../contracts";
import { qd } from "../quickdraw";

interface TaskRow {
  readonly createdAt: Date;
  readonly updatedAt: Date;
}

/** A task row as the board query's schema output carries it: dates as ISO strings. */
function toWire<Row extends TaskRow>(
  row: Row,
): Omit<Row, "createdAt" | "updatedAt"> & {
  createdAt: string;
  updatedAt: string;
} {
  return { ...row, createdAt: row.createdAt.toISOString(), updatedAt: row.updatedAt.toISOString() };
}

/**
 * Tasks, the way the 5.0 README teaches: access inherited from the task's
 * project, the board collection anchored on the project, the read/write
 * kit for single rows and card lists, the board query shared across
 * everyone who asks for it at once, and a mutation that writes through the
 * tracked client: its subscribers get the entity frame, the collection
 * delta and the board query's change signal without a hand-written emit.
 */
export const taskService = qd.defineService(taskContract, {
  model: "task",
  access: inherit({ from: projectContract, via: "projectId" }),
  collections: { cardsByProject: { anchor: projectContract } },
  methods: {
    ...crud.handlers(taskContract, {
      // `list` returns only the rows the policy lets the caller read
      access: { get: { entry: "Read" }, list: "authenticated", update: { entry: "Moderate" } },
    }),
    getTasksByStatus: {
      access: { scope: "Read", of: projectContract, id: "projectId" },
      // every viewer asks again when the board changes: one run serves them all
      share: "all",
      handler: async ({ input, db }) =>
        await Promise.all(
          BOARD_STATUSES.map(async (status) => {
            const where = { projectId: input.projectId, status };
            const [tasks, totalCount] = await Promise.all([
              db.task.findMany({
                where,
                orderBy: [{ ordinal: "asc" }, { id: "asc" }],
                take: BOARD_PAGE_SIZE,
              }),
              db.task.count({ where }),
            ]);
            return { status, tasks: tasks.map(toWire), totalCount };
          }),
        ),
    },
    // quickdraw: hand-written because the bench's writers call 4.1's updateTask on both apps, beside the kit's update
    updateTask: {
      access: { entry: "Moderate" },
      handler: ({ input: { id, ...changes }, db }) =>
        db.task.update({ where: { id }, data: changes }),
    },
  },
});
