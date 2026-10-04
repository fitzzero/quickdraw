"use client";
import type { UseCollectionResult } from "@fitzzero/quickdraw-core/client";
import { qd } from "../lib/quickdraw";
import type { TaskCard } from "@project/shared";

export function TaskBoard({ projectId }: { projectId: string }) {
  // quickdraw-migrate: review [client] compare is gone: items follow the contract collection's order (put the sort there)
  const { items, isLoading, loadMore, hasMore } = qd.taskService.byProject.useCollection(
    projectId,
    { compare: (a: TaskCard, b: TaskCard) => a.ordinal - b.ordinal },
  ) as UseCollectionResult<TaskCard, { readonly id: string }>;
  const { data: labels, refetch } = qd.labelService.listLabels.useQuery({ projectId });
  const moveTask = qd.taskService.moveTask.useMutation({
    onSuccess: () => {
      // quickdraw-migrate: review [client] manual refetch: live data, watch and the invalidation coordinator keep quickdraw queries current; delete it, or give the query a watch
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
