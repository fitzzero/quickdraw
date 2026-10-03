// The provider and the typed client's hooks rendered against a real server
// (RFC 0003 sections 11, 11.1 and 11.2): queries and mutations, waiting for
// the connection and for a backoff, `qd:cancel` on unmount, not-modified
// refetches, retries, strict mode, new credentials and `useQuickdraw`.

import { QueryClient } from "@tanstack/react-query";
import { act, render, renderHook, screen, waitFor } from "@testing-library/react";
import * as React from "react";
import { describe, expect, it } from "vitest";
import { QuickdrawError } from "../index";
import type { ConnectionAuth, QuickdrawConnection } from "./connection";
import { createQuickdrawClient } from "./createClient";
import { QuickdrawProvider, useQuickdraw, type QuickdrawStatus } from "./provider";
import { alice, bob, clientHarness, counter, outgoing, probe, until } from "./__tests__/fixtures";

const harness = clientHarness();
const qd = createQuickdrawClient({ counter, probe });

interface Setup {
  readonly url: string;
  readonly auth?: ConnectionAuth;
  readonly queryClient?: QueryClient;
  readonly timeoutMs?: number;
}

function Provider({
  url,
  auth = { principal: alice },
  queryClient,
  timeoutMs,
  children,
}: Setup & {
  readonly children?: React.ReactNode;
}) {
  return (
    <QuickdrawProvider
      client={qd}
      url={url}
      auth={auth}
      transports={["websocket"]}
      {...(queryClient === undefined ? {} : { queryClient })}
      {...(timeoutMs === undefined ? {} : { timeoutMs })}
    >
      {children}
    </QuickdrawProvider>
  );
}

function wrapperFor(setup: Setup) {
  return ({ children }: { readonly children?: React.ReactNode }) => (
    <Provider {...setup}>{children}</Provider>
  );
}

/** Renders `useQuickdraw` beside the hook under test, to reach the provider's connection. */
function withStatus<T>(
  hook: () => T,
): () => { readonly value: T; readonly status: QuickdrawStatus } {
  return () => ({ value: hook(), status: useQuickdraw() });
}

function Echo() {
  const { data } = qd.probe.echo.useQuery({ text: "hi" });
  return <p>{data === undefined ? "loading" : `user ${String(data.userId)}`}</p>;
}

describe("useQuery", () => {
  it("renders a query's data from a real server, once connected", async () => {
    const { app } = await harness.start();
    render(
      <Provider url={app.url}>
        <Echo />
      </Provider>,
    );
    expect(screen.getByText("loading")).toBeTruthy();
    await screen.findByText("user alice");
  });

  it("waits while queries back off after RATE_LIMITED, then refetches what went stale", async () => {
    const { app, records } = await harness.start();
    const queryClient = new QueryClient();
    const { result } = renderHook(
      withStatus(() => qd.counter.read.useQuery({ name: "a" })),
      { wrapper: wrapperFor({ url: app.url, queryClient }) },
    );
    await waitFor(() => expect(result.current.value.data).toEqual({ name: "a", value: 0 }));
    act(() => {
      result.current.status.connection.reportRateLimited("query", 250);
    });
    expect(result.current.status.isRateLimited).toBe(true);
    await act(async () => {
      await queryClient.invalidateQueries({ queryKey: qd.counter.read.key({ name: "a" }) });
    });
    expect(records).toHaveLength(1);
    await waitFor(() => expect(result.current.status.isRateLimited).toBe(false));
    await until(() => records.length === 2);
    expect(records.map((record) => record.outcome)).toEqual(["ok", "not-modified"]);
  });

  it("sends the cached version on a refetch and keeps the cached object when not modified", async () => {
    const { app, records, counter: counterService } = await harness.start();
    const queryClient = new QueryClient();
    const { result } = renderHook(() => qd.counter.read.useQuery({ name: "b" }), {
      wrapper: wrapperFor({ url: app.url, queryClient }),
    });
    await waitFor(() => expect(result.current.data).toEqual({ name: "b", value: 0 }));
    const first = result.current.data;
    const firstUpdate = result.current.dataUpdatedAt;
    await act(async () => {
      await new Promise((resolve) => {
        setTimeout(resolve, 5);
      });
      await result.current.refetch();
    });
    await waitFor(() => expect(result.current.dataUpdatedAt).toBeGreaterThan(firstUpdate));
    expect(result.current.data).toBe(first);
    counterService.values.set("b", 5);
    await act(async () => {
      await result.current.refetch();
    });
    await waitFor(() => expect(result.current.data).toEqual({ name: "b", value: 5 }));
    expect(records.map((record) => record.outcome)).toEqual(["ok", "not-modified", "ok"]);
  });

  it("sends qd:cancel when the last component reading a fetch unmounts", async () => {
    const { app, probe: probeService } = await harness.start();
    const grabbed: QuickdrawConnection[] = [];
    function Grab() {
      const { connection } = useQuickdraw();
      grabbed.push(connection);
      return null;
    }
    function Waiting() {
      qd.probe.wait.useQuery({ key: "unmount" });
      return <p>waiting</p>;
    }
    function Toggle({ show }: { readonly show: boolean }) {
      return (
        <Provider url={app.url}>
          <Grab />
          {show ? <Waiting /> : <p>gone</p>}
        </Provider>
      );
    }
    const view = render(<Toggle show />);
    const sent = outgoing(grabbed[0] as QuickdrawConnection);
    await until(() => probeService.signals.has("unmount"));
    view.rerender(<Toggle show={false} />);
    await until(() => probeService.signals.get("unmount")?.aborted === true);
    expect(sent.map(([event]) => event)).toEqual(["qd:call", "qd:cancel"]);
    expect(screen.getByText("gone")).toBeTruthy();
  });

  it("retries once after INTERNAL and never after TIMEOUT", async () => {
    const { app, records, probe: probeService } = await harness.start();
    const wrapper = wrapperFor({ url: app.url, timeoutMs: 100 });
    const internal = renderHook(
      () => qd.probe.fail.useQuery({ code: "INTERNAL" }, { retryDelay: 10 }),
      { wrapper },
    );
    await waitFor(() => expect(internal.result.current.isError).toBe(true));
    expect(internal.result.current.failureCount).toBe(2);
    expect(internal.result.current.error).toBeInstanceOf(QuickdrawError);
    expect(records.filter((record) => record.method === "fail")).toHaveLength(2);
    const timedOut = renderHook(() => qd.probe.wait.useQuery({ key: "slow" }, { retryDelay: 10 }), {
      wrapper,
    });
    await waitFor(() => expect(timedOut.result.current.isError).toBe(true));
    expect(timedOut.result.current.error).toMatchObject({ code: "TIMEOUT" });
    expect(timedOut.result.current.failureCount).toBe(1);
    expect([...probeService.signals.keys()]).toEqual(["slow"]);
  });
});

describe("useMutation", () => {
  it("runs a mutation, and fails with a QuickdrawError", async () => {
    const { app } = await harness.start();
    const wrapper = wrapperFor({ url: app.url });
    const bump = renderHook(() => qd.counter.bump.useMutation(), { wrapper });
    let output: unknown;
    await act(async () => {
      output = await bump.result.current.mutateAsync({ name: "a" });
    });
    expect(output).toEqual({ name: "a", value: 1 });
    await waitFor(() => expect(bump.result.current.data).toEqual({ name: "a", value: 1 }));
    const moderate = renderHook(() => qd.probe.moderate.useMutation(), { wrapper });
    act(() => {
      moderate.result.current.mutate({ value: 2 });
    });
    await waitFor(() => expect(moderate.result.current.isError).toBe(true));
    expect(moderate.result.current.error).toBeInstanceOf(QuickdrawError);
    expect(moderate.result.current.error?.code).toBe("FORBIDDEN");
  });
});

describe("QuickdrawProvider", () => {
  it("connects once in strict mode", async () => {
    const { app } = await harness.start();
    const sockets = new Set<string>();
    app.server.io.on("connection", (socket) => {
      sockets.add(socket.id);
    });
    render(
      <React.StrictMode>
        <Provider url={app.url}>
          <Echo />
        </Provider>
      </React.StrictMode>,
    );
    await screen.findByText("user alice");
    expect(sockets.size).toBe(1);
  });

  it("reconnects with new credentials and refetches what it cached", async () => {
    const { app } = await harness.start();
    const view = render(
      <Provider url={app.url} auth={{ principal: alice }}>
        <Echo />
      </Provider>,
    );
    await screen.findByText("user alice");
    view.rerender(
      <Provider url={app.url} auth={{ principal: bob }}>
        <Echo />
      </Provider>,
    );
    await screen.findByText("user bob");
  });

  it("reports the connection with useQuickdraw, and lends it to the client's call while mounted", async () => {
    const { app } = await harness.start();
    const view = renderHook(() => useQuickdraw(), { wrapper: wrapperFor({ url: app.url }) });
    await waitFor(() => expect(view.result.current.isConnected).toBe(true));
    await waitFor(() => expect(view.result.current.hello).not.toBeNull());
    expect(view.result.current).toMatchObject({
      status: "connected",
      hello: { protocol: 5 },
      serviceAccess: null,
      refusal: null,
      isRateLimited: false,
    });
    expect(await qd.counter.total.call()).toBe(0);
    view.unmount();
    await until(() => view.result.current.connection.getState().status === "idle");
    await expect(qd.counter.total.call()).rejects.toMatchObject({ code: "INTERNAL" });
  });

  it("throws a clear error for a hook rendered outside a provider", () => {
    expect(() => renderHook(() => qd.counter.read.useQuery({ name: "a" }))).toThrow(
      "counterService.read.useQuery must be rendered inside a <QuickdrawProvider>",
    );
  });
});
