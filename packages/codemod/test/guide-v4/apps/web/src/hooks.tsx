"use client";

import type { TaskDTO } from "@project/shared";

// #region hooks
import {
  useCollection,
  useService,
  useServiceQuery,
  useSubscription,
} from "@fitzzero/quickdraw-core/client";

export function TaskPanel({ taskId, projectId }: { taskId: string; projectId: string }) {
  const { data: task } = useSubscription<TaskDTO>("taskService", taskId);
  const { items } = useCollection<TaskDTO>("taskService", "byProject", projectId);
  const { data: health } = useServiceQuery<Record<string, never>, { at: string }>(
    "healthService",
    "ping",
    {},
  );
  const rename = useService<{ id: string; title: string }, TaskDTO | null>(
    "taskService",
    "renameTask",
  );
  return (
    <button type="button" onClick={() => rename.mutate({ id: taskId, title: "Renamed" })}>
      {`${task?.title ?? ""}: ${String(items.length)} on the board, up since ${health?.at ?? "?"}`}
    </button>
  );
}
// #endregion

// #region invalidate
export function Members({ projectId }: { projectId: string }) {
  const { data } = useServiceQuery<{ projectId: string }, { userId: string }[]>(
    "projectService",
    "getMembers",
    { projectId },
    { invalidateOn: ["project:members"] },
  );
  return <span>{data?.length ?? 0}</span>;
}
// #endregion

// #region events
import { useChannelSend, useRoomEvents } from "@fitzzero/quickdraw-core/client";

export function Board({ projectId }: { projectId: string }) {
  useRoomEvents({ "task:archived": (event) => console.info("archived", event.id, projectId) });
  const cursor = useChannelSend<{ projectId: string; x: number }>("taskService", "cursor");
  return <div onMouseMove={(event) => cursor.send({ projectId, x: event.clientX })} />;
}
// #endregion

// #region errors
import { ServiceCallError, useQuickdrawSocket } from "@fitzzero/quickdraw-core/client";
import type { ServiceResponse } from "@fitzzero/quickdraw-core";

export function useRename(): (id: string) => Promise<string> {
  const { socket } = useQuickdrawSocket();
  return (id) =>
    new Promise((resolve, reject) => {
      socket?.emit(
        "taskService:renameTask",
        { id, title: "x" },
        (reply: ServiceResponse<TaskDTO>) => {
          if (reply.success) {
            resolve(reply.data?.title ?? "");
          } else {
            reject(new ServiceCallError(reply.error ?? "failed", reply.code));
          }
        },
      );
    });
}
// #endregion

// #region inputs
import { SocketTextField } from "@fitzzero/quickdraw-core/client";

export function TitleField({ task }: { task: TaskDTO }) {
  const rename = useService<{ id: string; title: string }, TaskDTO | null>(
    "taskService",
    "renameTask",
  );
  return (
    <SocketTextField
      state={task}
      update={(patch: { title?: string }) =>
        rename.mutateAsync({ id: task.id, title: patch.title ?? "" })
      }
      property="title"
    />
  );
}
// #endregion
