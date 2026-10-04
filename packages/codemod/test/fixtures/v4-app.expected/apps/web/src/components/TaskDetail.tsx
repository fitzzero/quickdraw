"use client";

import { qd } from "../lib/quickdraw";

export function TaskDetail({ taskId }: { taskId: string }) {
  const { data: task, isLoading, error } = qd.taskService.useEntity(taskId);
  const updateTask = qd.taskService.updateTask.useMutation();

  // quickdraw-migrate: review [client] error is a QuickdrawError now (4.x: the message string): read error.message, or error.code (FORBIDDEN, NOT_FOUND, ...) to tell failures apart
  if (error?.includes("403")) return <p>You have no access to this task</p>;
  if (isLoading || !task) return null;
  return (
    <article>
      <h1>{task.title}</h1>
      <button type="button" onClick={() => updateTask.mutate({ id: taskId, title: `${task.title}!` })}>
        Rename
      </button>
    </article>
  );
}
