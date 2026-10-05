import { task } from "../../../../../packages/shared/src/kits/realtime";
import { qd } from "../../quickdraw";

// #region rooms
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

// a tick loop's "is anyone watching?", at its tick rate: this node's sockets in the room,
// anonymous ones too, with no promise (presence.count asks every node for users)
export function hasAudience(projectId: string): boolean {
  return qd.rooms.size(boardRoom(projectId)) > 0;
}
// #endregion
