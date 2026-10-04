// Query keys (RFC 0003 section 11.5), of method calls, live entities and live
// collection scopes, and their prefixes, as TanStack Query matches them.

import { QueryClient } from "@tanstack/react-query";
import { describe, expect, it } from "vitest";
import {
  KEY_ROOT,
  collectionKey,
  entityKey,
  methodKey,
  methodKeyPrefix,
  serviceKeyPrefix,
} from "./keys";

describe("method keys", () => {
  it("are [qd, service, m, method, input], holding the input itself", () => {
    const input = { id: "t1", tags: ["a"] };
    const key = methodKey("taskService", "get", input);
    expect(key).toEqual([KEY_ROOT, "taskService", "m", "get", { id: "t1", tags: ["a"] }]);
    expect(key[4]).toBe(input);
    expect(methodKeyPrefix("taskService", "get")).toEqual(["qd", "taskService", "m", "get"]);
    expect(serviceKeyPrefix("taskService")).toEqual(["qd", "taskService"]);
  });

  it("share one cache entry for inputs whose fields differ only in order", () => {
    const queryClient = new QueryClient();
    queryClient.setQueryData(methodKey("taskService", "list", { a: 1, b: 2 }), "cached");
    expect(queryClient.getQueryData(methodKey("taskService", "list", { b: 2, a: 1 }))).toBe(
      "cached",
    );
  });

  it("match every input of a method, or every key of a service, by prefix", () => {
    const queryClient = new QueryClient();
    for (const [method, id] of [
      ["get", "t1"],
      ["get", "t2"],
      ["find", "t1"],
    ] as const) {
      queryClient.setQueryData(methodKey("taskService", method, { id }), id);
    }
    queryClient.setQueryData(methodKey("projectService", "get", { id: "p1" }), "p1");
    const matching = (queryKey: readonly unknown[]) =>
      queryClient.getQueryCache().findAll({ queryKey }).length;
    expect(matching(methodKeyPrefix("taskService", "get"))).toBe(2);
    expect(matching(serviceKeyPrefix("taskService"))).toBe(3);
    expect(matching([KEY_ROOT])).toBe(4);
  });
});

describe("live keys", () => {
  it("are [qd, service, e, id] and [qd, service, c, collection, scope], under the service's prefix", () => {
    expect(entityKey("taskService", "t1")).toEqual(["qd", "taskService", "e", "t1"]);
    expect(collectionKey("taskService", "byProject", "p1")).toEqual([
      "qd",
      "taskService",
      "c",
      "byProject",
      "p1",
    ]);
    const queryClient = new QueryClient();
    queryClient.setQueryData(entityKey("taskService", "t1"), "row");
    queryClient.setQueryData(collectionKey("taskService", "byProject", "p1"), "scope");
    queryClient.setQueryData(methodKey("taskService", "get", { id: "t1" }), "result");
    expect(
      queryClient.getQueryCache().findAll({ queryKey: serviceKeyPrefix("taskService") }),
    ).toHaveLength(3);
  });
});
