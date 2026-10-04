"use client";

import { createQuickdrawClient } from "@fitzzero/quickdraw-core/client";
import { useState } from "react";
import { task } from "../../../../../packages/shared/src/kits/search";

const qd = createQuickdrawClient({ task });

// #region component
export function TaskSearch({ projectId }: { readonly projectId: string }) {
  const [text, setText] = useState("");
  // debounced, superseded searches cancelled, results live while the board is open
  const { items, isSearching } = qd.task.search.useSearch(text, { scope: projectId });
  return (
    <>
      <input value={text} onChange={(event) => setText(event.target.value)} />
      {isSearching ? <p>Searching…</p> : null}
      <ul>
        {items.map((card) => (
          <li key={card.id}>{card.title}</li>
        ))}
      </ul>
    </>
  );
}
// #endregion
