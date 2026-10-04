import { projectContract } from "@project/shared";
import { task } from "../../../../../packages/shared/src/kits/realtime";
import { qd } from "../../quickdraw";

// #region service
import { inherit } from "@fitzzero/quickdraw-core/server";

export const taskService = qd.defineService(task, {
  model: "task",
  access: inherit({ from: projectContract, via: "projectId" }),
  methods: {
    enterBoard: {
      access: { scope: "Read", of: projectContract, id: "projectId" },
      handler: ({ input, ctx }) => ctx.rooms.join(`board:${input.projectId}`),
    },
  },
  channels: {
    // relay each cursor to the board's room
    cursor: (payload, ctx) => {
      ctx.rooms.emit(`board:${payload.projectId}`, task, "cursorMoved", payload);
    },
  },
});

// in handlers, jobs and timers
export function logLine(taskId: string, line: string): void {
  qd.stream(task, "logs").push(taskId, { line });
}

export async function isOnline(userId: string): Promise<boolean> {
  // also ctx.presence and server.presence
  return await qd.presence.isOnline(userId);
}
// #endregion
