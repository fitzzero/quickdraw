import { defineContract, mutation } from "@fitzzero/quickdraw-core";
import { z } from "zod";
import { taskSchema } from "../schemas";

const cursorSchema = z.object({ projectId: z.string(), taskId: z.string(), x: z.number() });
const logLineSchema = z.object({ line: z.string() });

export const task = defineContract("taskService", {
  entity: taskSchema,
  methods: {
    enterBoard: mutation({ input: z.object({ projectId: z.string() }), output: z.boolean() }),
  },
  streams: {
    // one feed per task; a subscriber needs Read on the task, and first gets the latest 50 lines
    logs: { item: logLineSchema, scope: "taskId", seed: 50, access: { entry: "Read" } },
    // one feed for everyone
    load: { item: z.number(), volatile: true, access: "authenticated" },
  },
  channels: {
    // 20 a second per socket; only from a socket subscribed to the task the payload names
    cursor: { payload: cursorSchema, ratePerSecond: 20, requires: { entity: "taskId" } },
  },
  events: { cursorMoved: { payload: cursorSchema } },
});
