import { defineContract, mutation } from "@fitzzero/quickdraw-core";
import { z } from "zod";
import { taskSchema } from "../schemas";

const cursorSchema = z.object({ projectId: z.string(), taskId: z.string(), x: z.number() });
const logLineSchema = z.object({ line: z.string() });

export const task = defineContract("taskService", {
  describe: "Tasks on a project's board.",
  entity: taskSchema,
  methods: {
    enterBoard: mutation({
      input: z.object({ projectId: z.string() }),
      output: z.boolean(),
      describe: "Joins the caller's socket to a project's board room.",
    }),
  },
  streams: {
    // one feed per task; a subscriber needs Read on the task, and first gets the latest 50 lines
    logs: {
      item: logLineSchema,
      scope: "taskId",
      seed: 50,
      access: { entry: "Read" },
      describe: "A task's log lines, as its job writes them.",
    },
    // one feed for everyone
    load: {
      item: z.number(),
      volatile: true,
      access: "authenticated",
      describe: "The server's load, sampled every second.",
    },
  },
  channels: {
    // 20 a second per socket; only from a socket in the board's room, which enterBoard joined
    cursor: {
      describe: "Where a user's cursor is on a task card.",
      payload: cursorSchema,
      ratePerSecond: 20,
      requires: { room: (cursor) => `board:${cursor.projectId}` },
    },
  },
  events: {
    cursorMoved: { payload: cursorSchema, describe: "Another user's cursor moved." },
    // a user's last socket left a board: `onRoomLeave` sends it
    leftBoard: {
      payload: z.object({ projectId: z.string(), userId: z.string() }),
      describe: "A user left a project's board.",
    },
  },
});
