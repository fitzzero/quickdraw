"use client";

import { useService, useSubscription } from "../hooks";

export function TaskDetail({ taskId }: { taskId: string }) {
  const { data: task, isLoading, error } = useSubscription("taskService", taskId);
  const updateTask = useService("taskService", "updateTask");

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
