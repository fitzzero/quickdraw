"use client";

import {
  healthContract,
  taskContract,
} from "../../../../../packages/shared/src/migration/contracts";

// #region client
import { createQuickdrawClient } from "@fitzzero/quickdraw-core/client";

// apps/web/src/lib/quickdraw.ts: keyed by service name, as the codemod writes it
export const qd = createQuickdrawClient({
  taskService: taskContract,
  healthService: healthContract,
});
// #endregion

// #region hooks
export function TaskPanel({ taskId, projectId }: { taskId: string; projectId: string }) {
  // was useSubscription
  const { data: task } = qd.taskService.useEntity(taskId);
  // was useCollection
  const { items } = qd.taskService.byProject.useCollection(projectId);
  // was useServiceQuery
  const { data: health } = qd.healthService.ping.useQuery();
  // was useService
  const rename = qd.taskService.renameTask.useMutation();
  return (
    <button type="button" onClick={() => rename.mutate({ id: taskId, title: "Renamed" })}>
      {`${task?.title ?? ""}: ${String(items.length)} on the board, up since ${health?.at ?? "?"}`}
    </button>
  );
}
// #endregion

// #region events
export function Board({ projectId, onArchived }: { projectId: string; onArchived: () => void }) {
  // was useRoomEvents
  qd.taskService.archived.useEvent((event) => {
    if (event.projectId === projectId) {
      onArchived();
    }
  });
  // was useChannelSend
  const cursor = qd.taskService.cursor.useChannel();
  return <div onMouseMove={(event) => cursor.send({ projectId, x: event.clientX })} />;
}
// #endregion

// #region errors
import { QuickdrawError } from "@fitzzero/quickdraw-core";

export async function renameOrExplain(id: string): Promise<string> {
  try {
    const task = await qd.taskService.renameTask.call({ id, title: "Renamed" });
    return task?.title ?? "";
  } catch (error) {
    // was ServiceResponse { success, error, code } and ServiceCallError
    if (error instanceof QuickdrawError && error.code === "FORBIDDEN") {
      return "You may not rename this task.";
    }
    throw error;
  }
}
// #endregion
