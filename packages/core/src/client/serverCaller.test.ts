// `createServerCaller` against a real server's HTTP transport (RFC 0003
// section 10): data, errors, the JSON content type on every request, headers,
// cancellation, and `prefetch` filling a `QueryClient` under the key the
// client's hooks read.

import { QueryClient } from "@tanstack/react-query";
import { describe, expect, it } from "vitest";
import { createQuickdrawClient } from "./createClient";
import { createServerCaller } from "./serverCaller";
import { clientHarness, counter, probe, until } from "./__tests__/fixtures";

const harness = clientHarness();

describe("createServerCaller", () => {
  it("calls queries and mutations over HTTP, authenticated by the headers it sends", async () => {
    const { app } = await harness.start();
    const server = createServerCaller(
      { probe, counter },
      { url: app.url, headers: { authorization: "Bearer erin" } },
    );
    expect(await server.probe.echo.call({ text: "hi" })).toEqual({
      text: "hi",
      userId: "erin",
      transport: "http",
      grants: null,
    });
    expect(await server.counter.bump.call({ name: "a" })).toEqual({ name: "a", value: 1 });
    expect(await server.counter.total.call()).toBe(1);
  });

  it("sends Content-Type: application/json on every request, with or without a body", async () => {
    const { app } = await harness.start();
    const requests: { readonly url: unknown; readonly init: RequestInit | undefined }[] = [];
    const server = createServerCaller(
      { counter },
      {
        url: `${app.url}/`,
        headers: () =>
          Promise.resolve({ authorization: "Bearer erin", "content-type": "text/plain" }),
        fetch: (url, init) => {
          requests.push({ url, init });
          return fetch(url, init);
        },
      },
    );
    expect(await server.counter.total.call()).toBe(0);
    expect(await server.counter.read.call({ name: "b" })).toEqual({ name: "b", value: 0 });
    expect(requests.map(({ url, init }) => [url, init?.method, init?.body])).toEqual([
      [`${app.url}/qd/counterService/total`, "POST", undefined],
      [`${app.url}/qd/counterService/read`, "POST", '{"name":"b"}'],
    ]);
    for (const { init } of requests) {
      const headers = new Headers(init?.headers);
      expect(headers.get("content-type")).toBe("application/json");
      expect(headers.get("authorization")).toBe("Bearer erin");
    }
  });

  it("rejects with the reply's QuickdrawError, or INTERNAL when there is no call reply", async () => {
    const { app } = await harness.start();
    const server = createServerCaller({ probe }, { url: app.url });
    await expect(server.probe.fail.call({ code: "FORBIDDEN" })).rejects.toMatchObject({
      code: "FORBIDDEN",
      message: "Failed with FORBIDDEN",
    });
    await expect(server.probe.wait.call({ key: "anonymous" })).rejects.toMatchObject({
      code: "UNAUTHENTICATED",
    });
    const answering = (response: Response) =>
      createServerCaller({ probe }, { url: app.url, fetch: () => Promise.resolve(response) });
    await expect(
      answering(new Response("<html>", { status: 502 })).probe.echo.call({ text: "x" }),
    ).rejects.toMatchObject({
      code: "INTERNAL",
      message: "probeService.echo answered HTTP 502 without a JSON reply",
    });
    await expect(
      answering(Response.json({ hello: true })).probe.echo.call({ text: "x" }),
    ).rejects.toMatchObject({
      code: "INTERNAL",
      message: "probeService.echo answered HTTP 200 with no call reply",
    });
    const unreachable = createServerCaller({ probe }, { url: "http://127.0.0.1:1" });
    const error: unknown = await unreachable.probe.echo
      .call({ text: "x" })
      .catch((reason: unknown) => reason);
    expect(error).toMatchObject({
      code: "INTERNAL",
      message: "probeService.echo: the HTTP request failed",
    });
    expect((error as Error).cause).toBeInstanceOf(Error);
  });

  it("cancels the request when its signal aborts", async () => {
    const { app, probe: probeService } = await harness.start();
    const server = createServerCaller(
      { probe },
      { url: app.url, headers: { authorization: "Bearer erin" } },
    );
    const controller = new AbortController();
    const pending = server.probe.wait.call({ key: "http" }, { signal: controller.signal });
    await until(() => probeService.signals.has("http"));
    controller.abort();
    await expect(pending).rejects.toMatchObject({ code: "CANCELLED" });
    await until(() => probeService.signals.get("http")?.aborted === true);
  });

  it("prefetches into a QueryClient under the key the client's hooks read, and never rejects", async () => {
    const { app, counter: counterService } = await harness.start();
    counterService.values.set("a", 3);
    const qd = createQuickdrawClient({ counter, probe });
    const server = createServerCaller({ counter, probe }, { url: app.url });
    const queryClient = new QueryClient();
    await server.counter.read.prefetch(queryClient, { name: "a" });
    expect(server.counter.read.key({ name: "a" })).toEqual([
      "qd",
      "counterService",
      "m",
      "read",
      { name: "a" },
    ]);
    expect(server.counter.read.key({ name: "a" })).toEqual(qd.counter.read.key({ name: "a" }));
    expect(queryClient.getQueryData(qd.counter.read.key({ name: "a" }))).toEqual({
      name: "a",
      value: 3,
    });
    await expect(
      server.probe.fail.prefetch(queryClient, { code: "FORBIDDEN" }),
    ).resolves.toBeUndefined();
    expect(queryClient.getQueryState(server.probe.fail.key({ code: "FORBIDDEN" }))).toMatchObject({
      status: "error",
      error: { code: "FORBIDDEN" },
    });
  });

  it("builds frozen members once: call, key and prefetch on a query, call on a mutation", async () => {
    const server = createServerCaller({ counter }, { url: "http://127.0.0.1:1/api" });
    expect(Object.keys(server.counter.read)).toEqual(["call", "key", "prefetch"]);
    expect(Object.keys(server.counter.bump)).toEqual(["call"]);
    expect(server.counter.read).toBe(server.counter.read);
    expect(Object.isFrozen(server) && Object.isFrozen(server.counter)).toBe(true);
    expect("then" in server).toBe(false);
    expect(await Promise.resolve(server)).toBe(server);
  });

  it("refuses a missing url, a reserved key and a value that is not a contract", () => {
    expect(() => createServerCaller({ counter }, { url: "" })).toThrow(TypeError);
    expect(() => createServerCaller({ then: counter }, { url: "http://x" })).toThrow(
      'createServerCaller: "then" cannot name a service',
    );
    expect(() => createServerCaller({ $admin: counter }, { url: "http://x" })).toThrow("reserved");
    expect(() => createServerCaller({ odd: {} as typeof counter }, { url: "http://x" })).toThrow(
      'createServerCaller: "odd" is not a contract from defineContract',
    );
  });
});
