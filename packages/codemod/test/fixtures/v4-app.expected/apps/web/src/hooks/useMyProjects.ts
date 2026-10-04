"use client";

// quickdraw-migrate: review [v4-api] 4.x API useQuickdrawSocket (removed): lint's no-v4-api names each replacement
import { useQuickdrawSocket } from "@fitzzero/quickdraw-core/client";
import type { UseCollectionResult } from "@fitzzero/quickdraw-core/client";
import { qd } from "../lib/quickdraw";
import type { ProjectListItem } from "@project/shared";

function byName(a: ProjectListItem, b: ProjectListItem): number {
  return a.name.localeCompare(b.name) || a.id.localeCompare(b.id);
}

/** The signed-in user's live project list: the `mine` collection. */
export function useMyProjects() {
  const { userId } = useQuickdrawSocket();
  // quickdraw-migrate: review [client] declare the collection "mine" in the projectService contract (see the [collection] marker where 4.x defined it): qd.projectService.mine does not exist until then, and the cast to the 4.x item type stands in for its type; delete the cast once it is declared
  // quickdraw-migrate: review [client] compare is gone: items follow the contract collection's order (put the sort there)
  return qd.projectService.mine.useCollection(userId ?? null, {
    compare: byName,
  }) as UseCollectionResult<ProjectListItem, { readonly id: string }>;
}
