"use client";

import { useQuickdrawSocket } from "@fitzzero/quickdraw-core/client";
import { useCollection, type UseCollectionResult } from "@fitzzero/quickdraw-core/client";
import type { ProjectListItem } from "@project/shared";

function byName(a: ProjectListItem, b: ProjectListItem): number {
  return a.name.localeCompare(b.name) || a.id.localeCompare(b.id);
}

/** The signed-in user's live project list: the `mine` collection. */
export function useMyProjects(): UseCollectionResult<ProjectListItem> {
  const { userId } = useQuickdrawSocket();
  return useCollection<ProjectListItem>("projectService", "mine", userId ?? null, {
    compare: byName,
  });
}
