"use client";

import { qd } from "../lib/quickdraw";

export function RenameLabel({ labelId }: { labelId: string }) {
  const rename = qd.labelService.renameLabel.useMutation();
  return (
    <button type="button" onClick={() => rename.mutate({ labelId, name: "Renamed" })}>
      Rename
    </button>
  );
}
