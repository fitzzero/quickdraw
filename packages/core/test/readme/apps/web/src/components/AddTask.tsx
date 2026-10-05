"use client";

import { newId } from "@fitzzero/quickdraw-core/client";
import { qd } from "../lib/quickdraw";

// #region add
export function TaskList({ projectId }: { readonly projectId: string }) {
  const { items, pending } = qd.task.board.useCollection(projectId);
  const create = qd.task.create.useMutation({
    // the new card shows at once, last on the board (its ordinal), until the server's arrives
    optimistic: (input, cache) =>
      cache.addItem("board", input.projectId, {
        // the id the client made: after a lost answer the board's next load finds the card
        id: input.id,
        projectId: input.projectId,
        title: input.title,
        status: "open",
        ordinal: Number.MAX_SAFE_INTEGER,
        assigneeId: null,
      }),
  });
  return (
    <>
      <ul>
        {items.map((task) => (
          // pending: the create is on its way; the card is the server's once it answers
          <li key={task.id} style={{ opacity: pending.has(task.id) ? 0.5 : 1 }}>
            {task.title}
          </li>
        ))}
      </ul>
      <button
        type="button"
        onClick={() => create.mutate({ id: newId(), projectId, title: "New task" })}
      >
        Add
      </button>
      {create.error === null ? null : <p>{`Not added: ${create.error.code}`}</p>}
    </>
  );
}
// #endregion
