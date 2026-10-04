"use client";

import { qd } from "../lib/quickdraw";

export function TaskDetail({ taskId }: { taskId: string }) {
  const { data: task, isLoading } = qd.taskService.useEntity(taskId);
  const updateTask = qd.taskService.updateTask.useMutation();

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
