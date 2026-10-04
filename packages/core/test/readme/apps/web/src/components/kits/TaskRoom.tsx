"use client";

import { createQuickdrawClient, useJoin, usePresence } from "@fitzzero/quickdraw-core/client";
import { useState } from "react";
import { task } from "../../../../../packages/shared/src/kits/realtime";

const qd = createQuickdrawClient({ task });

// #region component
export function TaskRoom({
  projectId,
  taskId,
}: {
  readonly projectId: string;
  readonly taskId: string;
}) {
  // the socket is in the board's room on every connection: a reconnect is a new socket in no room
  const board = useJoin(qd.task.enterBoard, { projectId });
  const { items } = qd.task.logs.useStream(taskId, { max: 200 });
  const { send, isReady } = qd.task.cursor.useChannel();
  const [lastX, setLastX] = useState(0);
  qd.task.cursorMoved.useEvent((cursor) => setLastX(cursor.x));
  // user ids, once enterBoard joined the room
  const here = usePresence(`board:${projectId}`);
  const move = (x: number) => isReady && board.isJoined && send({ projectId, taskId, x });
  return (
    <div onMouseMove={(event) => move(event.clientX)}>
      <p>{`${String(here.length)} here; a cursor at ${String(lastX)}`}</p>
      <pre>{items.map((item) => item.line).join("\n")}</pre>
    </div>
  );
}
// #endregion
