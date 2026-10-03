// `createQuickdrawClient` outside React (RFC 0003 section 11): members built
// once from the contracts, never thenable, and `call` / `prefetch` going over
// the connection the client is bound to.

import { QueryClient } from "@tanstack/react-query";
import { describe, expect, it } from "vitest";
import { bindConnection, createQuickdrawClient } from "./createClient";
import { versionOf } from "./versions";
import { clientHarness, counter, probe } from "./__tests__/fixtures";

const harness = clientHarness();

describe("createQuickdrawClient", () => {
  it("builds one frozen member per method, once, so hooks keep their identity", async () => {
    const qd = createQuickdrawClient({ counter, probe });
    expect(Object.keys(qd)).toEqual(["counter", "probe"]);
    expect(Object.keys(qd.counter)).toEqual(["read", "bump", "total"]);
    expect(Object.keys(qd.counter.read)).toEqual(["useQuery", "call", "key", "prefetch"]);
    expect(Object.keys(qd.counter.bump)).toEqual(["useMutation", "call"]);
    expect(qd.counter.read).toBe(qd.counter.read);
    expect(qd.counter.read.useQuery).toBe(qd.counter.read.useQuery);
    expect(qd.counter.bump.useMutation).toBe(qd.counter.bump.useMutation);
    expect([qd, qd.counter, qd.counter.read].every((member) => Object.isFrozen(member))).toBe(true);
    expect("then" in qd || "then" in qd.counter).toBe(false);
    expect(await Promise.resolve(qd)).toBe(qd);
    expect(await Promise.resolve(qd.counter)).toBe(qd.counter);
  });

  it("keys a call by service name, method and input, with no stringified input", () => {
    const qd = createQuickdrawClient({ counter });
    const input = { name: "a" };
    const key = qd.counter.read.key(input);
    expect(key).toEqual(["qd", "counterService", "m", "read", { name: "a" }]);
    expect(key[4]).toBe(input);
    expect(qd.counter.total.key()).toEqual(["qd", "counterService", "m", "total", undefined]);
  });

  it("calls over the bound connection, and fails with INTERNAL while none is bound", async () => {
    const { app } = await harness.start();
    const qd = createQuickdrawClient({ counter });
    await expect(qd.counter.total.call()).rejects.toMatchObject({
      code: "INTERNAL",
      message: "counterService.total.call needs a mounted <QuickdrawProvider> for this client",
    });
    const connection = await harness.connect(app.url);
    const unbind = bindConnection(qd, connection);
    expect(await qd.counter.bump.call({ name: "a" })).toEqual({ name: "a", value: 1 });
    expect(await qd.counter.read.call({ name: "a" })).toEqual({ name: "a", value: 1 });
    const queryClient = new QueryClient();
    await qd.counter.read.prefetch(queryClient, { name: "a" });
    const cached = queryClient.getQueryData(qd.counter.read.key({ name: "a" }));
    expect(cached).toEqual({ name: "a", value: 1 });
    expect(versionOf(cached)).toBe("a@1");
    unbind();
    await expect(qd.counter.read.prefetch(queryClient, { name: "a" })).rejects.toMatchObject({
      code: "INTERNAL",
    });
  });

  it("refuses a reserved key, a value that is not a contract, and binding a foreign object", () => {
    expect(() => createQuickdrawClient({ then: counter })).toThrow(
      'createQuickdrawClient: "then" cannot name a service',
    );
    expect(() => createQuickdrawClient({ odd: 1 as unknown as typeof counter })).toThrow(
      "is not a contract",
    );
    expect(() => bindConnection({}, harness.connection("http://127.0.0.1:1"))).toThrow(
      "client must be made by createQuickdrawClient",
    );
  });
});
