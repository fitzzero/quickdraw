"use client";

import { createQuickdrawClient } from "@fitzzero/quickdraw-core/client";
import { useInfiniteQuery } from "@tanstack/react-query";
import { task } from "../../../../../packages/shared/src/kits/crud";

const qd = createQuickdrawClient({ task });

// #region component
export function TaskPages({ projectId }: { readonly projectId: string }) {
  const filter = { projectId };
  // the list's own key (plus a suffix: pages are not one list result) and call,
  // so qd.invalidate(qd.task.list) refetches these pages too
  const pages = useInfiniteQuery({
    queryKey: [...qd.task.list.key({ filter }), "pages"],
    queryFn: ({ pageParam, signal }) =>
      qd.task.list.call({ filter, cursor: pageParam, limit: 50 }, { signal }),
    initialPageParam: undefined as string | undefined,
    getNextPageParam: (page) => page.nextCursor ?? undefined,
  });
  const cards = pages.data?.pages.flatMap((page) => page.items) ?? [];
  return (
    <>
      <ul>
        {cards.map((card) => (
          <li key={card.id}>{card.title}</li>
        ))}
      </ul>
      {pages.hasNextPage ? (
        <button type="button" onClick={() => void pages.fetchNextPage()}>
          More
        </button>
      ) : null}
    </>
  );
}
// #endregion
