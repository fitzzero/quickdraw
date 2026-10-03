// How a query fetches into the cache (RFC 0003 section 9, step 5): it sends
// the version of the cached result, keeps the cached object when the server
// answers "not modified", and calls again without a version when that
// result left the cache meanwhile, so it never resolves to `undefined`.

import { QueryClient } from "@tanstack/react-query";
import { describe, expect, it } from "vitest";
import type { CallEnvelope } from "../index";
import { shareKeepingVersion } from "./hooks";
import { methodKey } from "./keys";
import { fetchMethodQuery, type MethodQuery } from "./query";
import { rememberVersion, versionOf } from "./versions";
import { clientHarness, outgoing, until } from "./__tests__/fixtures";

const harness = clientHarness();

const input = { name: "a" };
const read: MethodQuery = {
  service: "counterService",
  method: "read",
  input,
  key: methodKey("counterService", "read", input),
};

async function setup() {
  const started = await harness.start();
  const connection = await harness.connect(started.app.url);
  const queryClient = new QueryClient();
  const first = await fetchMethodQuery(connection, queryClient, read);
  queryClient.setQueryData(read.key, first);
  const sent = outgoing(connection);
  const versions = (): unknown[] => sent.map(([, envelope]) => (envelope as CallEnvelope).v);
  return { ...started, connection, queryClient, first, versions };
}

describe("fetchMethodQuery", () => {
  it("sends the cached result's version and resolves with the cached object while it is current", async () => {
    const { connection, queryClient, first, versions, records, counter } = await setup();
    expect(first).toEqual({ name: "a", value: 0 });
    expect(versionOf(first)).toBe("a@0");
    expect(await fetchMethodQuery(connection, queryClient, read)).toBe(first);
    counter.values.set("a", 2);
    const changed = await fetchMethodQuery(connection, queryClient, read);
    expect(changed).toEqual({ name: "a", value: 2 });
    expect(versionOf(changed)).toBe("a@2");
    expect(versions()).toEqual(["a@0", "a@0"]);
    expect(records.map((record) => record.outcome)).toEqual(["ok", "not-modified", "ok"]);
  });

  it("keeps the version when the cache is set to equal data, which TanStack keeps as the same object", async () => {
    const { connection, queryClient, first, versions } = await setup();
    queryClient.setQueryData(read.key, { name: "a", value: 0 });
    expect(queryClient.getQueryData(read.key)).toBe(first);
    expect(await fetchMethodQuery(connection, queryClient, read)).toBe(first);
    expect(versions()).toEqual(["a@0"]);
  });

  it.each([
    ["removed", (client: QueryClient) => client.removeQueries({ queryKey: read.key })],
    ["replaced", (client: QueryClient) => client.setQueryData(read.key, { name: "a", value: 7 })],
  ])(
    "calls again without a version when the cached result was %s while it waited",
    async (_how, change) => {
      const { connection, queryClient, first, versions, records, counter } = await setup();
      const release = counter.hold();
      const pending = fetchMethodQuery(connection, queryClient, read);
      await until(() => versions().length === 1);
      change(queryClient);
      release();
      const result = await pending;
      expect(result).toEqual({ name: "a", value: 0 });
      expect(result).not.toBe(first);
      expect(versionOf(result)).toBe("a@0");
      expect(versions()).toEqual(["a@0", undefined]);
      expect(records.map((record) => record.outcome)).toEqual(["ok", "not-modified", "ok"]);
    },
  );

  it("sends no version for a cached result that came without one", async () => {
    const { connection, queryClient, versions } = await setup();
    queryClient.setQueryData(read.key, { name: "a", value: 5 });
    expect(await fetchMethodQuery(connection, queryClient, read)).toEqual({ name: "a", value: 0 });
    expect(versions()).toEqual([undefined]);
  });
});

describe("shareKeepingVersion", () => {
  it("moves the new result's version onto the object structural sharing keeps", () => {
    const share = shareKeepingVersion(undefined);
    expect(typeof share).toBe("function");
    const old = { name: "a", value: 1, tags: ["x"] };
    const same = { name: "a", value: 1, tags: ["x"] };
    rememberVersion(same, "a@9");
    const kept = (share as (a: unknown, b: unknown) => unknown)(old, same);
    expect(kept).toBe(old);
    expect(versionOf(old)).toBe("a@9");
    const changed = { name: "a", value: 2, tags: ["x"] };
    rememberVersion(changed, "a@10");
    const copy = (share as (a: unknown, b: unknown) => unknown)(old, changed) as typeof old;
    expect(copy.tags).toBe(old.tags);
    expect(versionOf(copy)).toBe("a@10");
  });

  it("leaves sharing off when it is off, and wraps a custom sharing function", () => {
    expect(shareKeepingVersion(false)).toBe(false);
    const custom = shareKeepingVersion(() => ({ kept: true }));
    const next = { v: 1 };
    rememberVersion(next, 3);
    const kept = (custom as (a: unknown, b: unknown) => unknown)(undefined, next);
    expect(kept).toEqual({ kept: true });
    expect(versionOf(kept)).toBe(3);
  });
});
