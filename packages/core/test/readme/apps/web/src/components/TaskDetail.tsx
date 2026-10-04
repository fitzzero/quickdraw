"use client";

import { qd } from "../lib/quickdraw";

// #region detail
export function TaskDetail({ id }: { readonly id: string }) {
  // live, at the user's level
  const { data: task, isRemoved, error } = qd.task.useEntity(id);
  const rename = qd.task.rename.useMutation({
    // the default for a mutation with `id` and an "entity" output, written out
    optimistic: (input, cache) => cache.patchEntity(input.id, { title: input.title }),
  });
  if (error?.code === "FORBIDDEN") {
    return <p>You cannot see this task.</p>;
  }
  if (isRemoved) {
    return <p>This task was deleted.</p>;
  }
  return (
    <div>
      <h1>{task?.title}</h1>
      {task?.notes === undefined ? null : <p>{task.notes}</p>}
      <button type="button" onClick={() => rename.mutate({ id, title: "Renamed" })}>
        Rename
      </button>
      {rename.error === null ? null : <p>{`Refused: ${rename.error.code}`}</p>}
    </div>
  );
}
// #endregion
