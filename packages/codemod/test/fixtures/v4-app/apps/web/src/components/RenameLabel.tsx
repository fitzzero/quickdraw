"use client";

import { useService } from "@fitzzero/quickdraw-core/client";

// The payload of the 4.x hook's type argument: nothing else names it
interface RenameLabelPayload {
  labelId: string;
  name: string;
}

export function RenameLabel({ labelId }: { labelId: string }) {
  const rename = useService<RenameLabelPayload, { id: string }>("labelService", "renameLabel");
  return (
    <button type="button" onClick={() => rename.mutate({ labelId, name: "Renamed" })}>
      Rename
    </button>
  );
}
