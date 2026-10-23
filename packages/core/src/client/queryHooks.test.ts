// `placeholderOption` (`queryHooks.ts`): the `placeholderData` a query hook
// gives TanStack takes a placeholder only from a query the cache still
// holds, so a result another user's session left in a mounted observer never
// shows again. The switch of users itself is rendered in `session.test.tsx`
// and `live/search.test.tsx`.

import { keepPreviousData, QueryClient, type Query } from "@tanstack/react-query";
import { describe, expect, it, vi } from "vitest";
import { placeholderOption } from "./queryHooks";

/** A placeholder function as TanStack calls it. */
type Asked = (previousData: unknown, previousQuery: Query | undefined) => unknown;

const key = ["qd", "taskService", "m", "get", { id: "t1" }];

/** A cache holding Ada's result under `key`, and its query. */
function adasResult() {
  const queryClient = new QueryClient();
  queryClient.setQueryData(key, { title: "Ada's" });
  const query = queryClient.getQueryCache().find({ queryKey: key, exact: true });
  return { queryClient, query };
}

describe("placeholderOption", () => {
  it("asks the caller's function about a query the cache holds, and never about one it no longer holds", () => {
    const { queryClient, query } = adasResult();
    const ask = vi.fn(keepPreviousData);
    const placeholder = placeholderOption(queryClient, key, { placeholderData: ask }) as Asked;
    expect(placeholder({ title: "Ada's" }, query)).toEqual({ title: "Ada's" });
    // Another user's hello empties the cache (`session.ts`).
    queryClient.removeQueries({ queryKey: ["qd"] });
    expect(placeholder({ title: "Ada's" }, query)).toBeUndefined();
    // A query made since under the same key is another query.
    queryClient.setQueryData(key, { title: "Ed's" });
    expect(placeholder({ title: "Ada's" }, query)).toBeUndefined();
    expect(ask).toHaveBeenCalledTimes(1);
    // With no query that held data, TanStack asks with nothing, and so does the hook.
    expect(placeholder(undefined, undefined)).toBeUndefined();
    expect(ask).toHaveBeenCalledTimes(2);
  });

  it("passes a value as it is: it is the app's own, never a result that was read", () => {
    const { queryClient } = adasResult();
    const empty = { items: [] };
    expect(placeholderOption(queryClient, key, { placeholderData: empty })).toBe(empty);
    expect(placeholderOption(queryClient, key, {})).toBeUndefined();
  });

  it("takes the cache's defaults when the caller names none, and an explicit undefined as none", () => {
    const { queryClient, query } = adasResult();
    queryClient.setDefaultOptions({ queries: { placeholderData: keepPreviousData } });
    const fromDefault = placeholderOption(queryClient, key, {}) as Asked;
    expect(fromDefault({ title: "Ada's" }, query)).toEqual({ title: "Ada's" });
    // The default is asked only about a query the cache holds, as the caller's own is.
    queryClient.removeQueries({ queryKey: ["qd"] });
    expect(fromDefault({ title: "Ada's" }, query)).toBeUndefined();
    expect(placeholderOption(queryClient, key, { placeholderData: undefined })).toBeUndefined();
    // A default set for the key wins over the cache's, as TanStack merges them.
    queryClient.setQueryDefaults(["qd", "taskService"], { placeholderData: { items: [] } });
    expect(placeholderOption(queryClient, key, {})).toEqual({ items: [] });
  });
});
