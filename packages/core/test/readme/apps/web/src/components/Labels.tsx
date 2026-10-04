"use client";

import { qd } from "../lib/quickdraw";

export function Labels({ projectId }: { readonly projectId: string }) {
  const { items } = qd.label.byProject.useCollection(projectId);
  const rename = qd.label.rename.useMutation();
  return (
    <ul>
      {items.map((label) => (
        <li key={label.id}>
          <button type="button" onClick={() => rename.mutate({ id: label.id, name: "urgent" })}>
            {label.name}
          </button>
        </li>
      ))}
    </ul>
  );
}
