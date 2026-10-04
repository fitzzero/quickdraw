import { task } from "../../../../../packages/shared/src/kits/realtime";
import { qd, type AppPrincipal } from "../../quickdraw";

// #region rooms
import type { RoomLeaveHandler } from "@fitzzero/quickdraw-core/server";

const boardRoom = (projectId: string): string => `board:${projectId}`;

// a timer or a game loop's tick, outside any handler: every socket in the room, on every node
export function showCursor(projectId: string, taskId: string, x: number): void {
  qd.rooms.emit(boardRoom(projectId), task, "cursorMoved", { projectId, taskId, x });
}

// a member removed from the project: their sockets leave its board on every node, so they hear
// nothing more of it and its cursor channel drops their messages (also ctx.rooms.leave)
export async function removeFromBoard(projectId: string, userId: string): Promise<void> {
  await qd.rooms.leave(boardRoom(projectId), { userId });
}

// qd.createServer({ ..., onRoomLeave }): once per socket that leaves app rooms, in a unit of its own
export const onRoomLeave: RoomLeaveHandler<AppPrincipal> = ({ principal, rooms }) => {
  for (const { room, last } of rooms) {
    // last: no socket of the user is in the room any more (a second tab keeps it false)
    if (principal !== null && last && room.startsWith("board:")) {
      const projectId = room.slice("board:".length);
      qd.rooms.emit(room, task, "leftBoard", { projectId, userId: principal.userId });
    }
  }
};
// #endregion
