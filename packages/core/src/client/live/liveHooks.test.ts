// The query a live hook observes its entry with (`entryQuery`): whatever
// `placeholderData` default the app's `QueryClient` sets, for every query or
// for quickdraw's keys, an entry never takes a placeholder. TanStack would
// make it from the last entry the hook's observer showed: another row's,
// another scope's, or another user's.

import { QueryClient, keepPreviousData } from "@tanstack/react-query";
import { describe, expect, it } from "vitest";
import { collectionKey, entityKey } from "../keys";
import { entryQuery } from "./liveHooks";

describe("entryQuery", () => {
  const keys = [entityKey("taskService", "t1"), collectionKey("taskService", "board", "p1")];

  it("takes no placeholder from a default every query gets", () => {
    const queryClient = new QueryClient();
    queryClient.setDefaultOptions({ queries: { placeholderData: keepPreviousData } });
    for (const key of keys) {
      expect(queryClient.defaultQueryOptions(entryQuery(key)).placeholderData).toBeUndefined();
    }
  });

  it("takes no placeholder from a default quickdraw's keys get", () => {
    const queryClient = new QueryClient();
    queryClient.setQueryDefaults(["qd"], { placeholderData: keepPreviousData });
    for (const key of keys) {
      expect(queryClient.defaultQueryOptions(entryQuery(key)).placeholderData).toBeUndefined();
    }
  });
});
