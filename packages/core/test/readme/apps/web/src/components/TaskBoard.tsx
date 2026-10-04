"use client";

import { qd } from "../lib/quickdraw";

export function TaskBoard({ projectId }: { readonly projectId: string }) {
  // Live: tasks added, changed, moved or removed by anyone show at once.
  const { items, isLoading } = qd.task.board.useCollection(projectId);
  const { data: count } = qd.task.countOnBoard.useQuery({ projectId });
  // Optimistic: the new title shows before the server answers.
  const rename = qd.task.rename.useMutation();

  if (isLoading) {
    return <p>Loading…</p>;
  }
  return (
    <section>
      <h2>{`${String(count ?? items.length)} tasks`}</h2>
      <ul>
        {items.map((task) => (
          <li key={task.id}>
            {task.title}
            <button type="button" onClick={() => rename.mutate({ id: task.id, title: "Done" })}>
              Rename
            </button>
          </li>
        ))}
      </ul>
    </section>
  );
}
