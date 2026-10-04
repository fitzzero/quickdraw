"use client";

import { useCollection, useService, useServiceQuery } from "../hooks";
import type { TaskCard } from "@project/shared";

export function TaskBoard({ projectId }: { projectId: string }) {
  const { items, isLoading, loadMore, hasMore } = useCollection<TaskCard>(
    "taskService",
    "byProject",
    projectId,
    { compare: (a: TaskCard, b: TaskCard) => a.ordinal - b.ordinal },
  );
  const { data: labels, refetch } = useServiceQuery("labelService", "listLabels", { projectId });
  const moveTask = useService("taskService", "moveTask", {
    onSuccess: () => {
      void refetch();
    },
  });

  if (isLoading) return <p>Loading…</p>;
  return (
    <div>
      <p>{`${labels?.length ?? 0} labels`}</p>
      {items.map((task) => (
        <button
          key={task.id}
          type="button"
          onClick={() => moveTask.mutate({ taskId: task.id, status: "done", ordinal: task.ordinal })}
        >
          {task.title}
        </button>
      ))}
      {hasMore ? (
        <button type="button" onClick={() => void loadMore()}>
          More
        </button>
      ) : null}
    </div>
  );
}
