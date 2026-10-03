// The README's server component example: prefetched over HTTP, hydrated into
// the client's cache.

import { dehydrate, HydrationBoundary, QueryClient } from "@tanstack/react-query";
import { TaskBoard } from "../../components/TaskBoard";

// #region page
import { createServerCaller } from "@fitzzero/quickdraw-core/utils";
import { contracts } from "@project/shared";

export async function TasksPage({ projectId, cookie }: { projectId: string; cookie: string }) {
  // forwards the user's session cookie to the API's HTTP transport
  const caller = createServerCaller(contracts, { url: "http://api:4000", headers: { cookie } });
  const queryClient = new QueryClient();
  await caller.task.countOnBoard.prefetch(queryClient, { projectId }); // the key useQuery reads
  return (
    <HydrationBoundary state={dehydrate(queryClient)}>
      <TaskBoard projectId={projectId} />
    </HydrationBoundary>
  );
}
// #endregion
