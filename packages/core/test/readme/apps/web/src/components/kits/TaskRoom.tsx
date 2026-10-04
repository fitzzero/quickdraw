"use client";

import { createQuickdrawClient, usePresence } from "@fitzzero/quickdraw-core/client";
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
  const { items } = qd.task.logs.useStream(taskId, { max: 200 });
  const { send, isReady } = qd.task.cursor.useChannel();
  const [lastX, setLastX] = useState(0);
  qd.task.cursorMoved.useEvent((cursor) => setLastX(cursor.x));
  const here = usePresence(`board:${projectId}`); // user ids, after enterBoard joined the room
  return (
    <div onMouseMove={(event) => isReady && send({ projectId, taskId, x: event.clientX })}>
      <p>{`${String(here.length)} here; a cursor at ${String(lastX)}`}</p>
      <pre>{items.map((item) => item.line).join("\n")}</pre>
    </div>
  );
}
// #endregion
