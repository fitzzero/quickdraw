// The provider and the typed client's hooks rendered against a real server
// (RFC 0003 sections 11, 11.1 and 11.2): queries and mutations, waiting for
// the connection and for a backoff, `qd:cancel` on unmount, not-modified
// refetches, retries, strict mode, new credentials and `useQuickdraw`, and
// the README's AuthGate through a server that cannot authenticate a
// reconnect (never the sign-in) and one that refuses it (the sign-in).

import { QueryClient, useQuery } from "@tanstack/react-query";
import { act, render, renderHook, screen, waitFor } from "@testing-library/react";
import * as React from "react";
import { describe, expect, it } from "vitest";
import { QuickdrawError } from "../index";
import { captureLogger, tick } from "../server/__tests__/fixtures";
import type { ConnectionAuth, QuickdrawConnection } from "./connection";
import { QuickdrawContext } from "./context";
import { createInvalidationCoordinator, type InvalidationCoordinator } from "./coordinator";
import { createQuickdrawClient } from "./createClient";
import { QuickdrawProvider, useQuickdraw, type QuickdrawStatus } from "./provider";
import { renderWithQuickdraw } from "../testing/client";
import {
  alice,
  bob,
  clientHarness,
  counter,
  outgoing,
  probe,
  testAuth,
  until,
} from "./__tests__/fixtures";

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

describe("setData", () => {
  function Read() {
    const { data } = qd.counter.read.useQuery({ name: "a" });
    return <p>{data === undefined ? "loading" : `value ${String(data.value)}`}</p>;
  }

  it("writes a query's cached result, shown at once, with no call", async () => {
    const { app, records } = await harness.start();
    render(
      <Provider url={app.url}>
        <Read />
      </Provider>,
    );
    await screen.findByText("value 0");
    act(() => {
      // what an event that carries the new value does
      qd.counter.read.setData({ name: "a" }, (cached) =>
        cached === undefined ? undefined : { ...cached, value: 7 },
      );
    });
    await screen.findByText("value 7");
    expect(records.filter((record) => record.method === "read")).toHaveLength(1);
  });

  it("follows a read in flight, which may predate the data written, with one more", async () => {
    const { app, records, counter: counterService } = await harness.start();
    render(
      <Provider url={app.url}>
        <Read />
      </Provider>,
    );
    await screen.findByText("value 0");
    const reads = () => records.filter((record) => record.method === "read").length;
    const release = counterService.hold();
    counterService.values.set("a", 5);
    act(() => {
      qd.invalidate(qd.counter.read, { name: "a" });
    });
    act(() => {
      qd.counter.read.setData({ name: "a" }, { name: "a", value: 9 });
    });
    await screen.findByText("value 9");
    release();
    await screen.findByText("value 5");
    await until(() => reads() === 3);
    expect(reads()).toBe(3);
  });

  it("needs a mounted provider", () => {
    expect(() => qd.counter.read.setData({ name: "a" }, { name: "a", value: 1 })).toThrow(
      "counterService.read.setData needs a mounted <QuickdrawProvider> for this client",
    );
  });
});

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
    // The default time limit: on a loaded machine an answer can take longer than a short one,
    // and the TIMEOUT it would end in is never retried.
    const internal = renderHook(
      () => qd.probe.fail.useQuery({ code: "INTERNAL" }, { retryDelay: 10 }),
      { wrapper: wrapperFor({ url: app.url }) },
    );
    await waitFor(() => expect(internal.result.current.isError).toBe(true));
    expect(internal.result.current.failureCount).toBe(2);
    expect(internal.result.current.error).toBeInstanceOf(QuickdrawError);
    expect(records.filter((record) => record.method === "fail")).toHaveLength(2);
    // A query runs once the connection is up, so only the server's wait counts toward the 100 ms.
    const timedOut = renderHook(() => qd.probe.wait.useQuery({ key: "slow" }, { retryDelay: 10 }), {
      wrapper: wrapperFor({ url: app.url, timeoutMs: 100 }),
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

  it("keeps its coordinator through strict mode, and disposes it a tick after it unmounts", async () => {
    const { app } = await harness.start();
    const queryClient = new QueryClient();
    const held: { coordinator?: InvalidationCoordinator } = {};
    function Grab() {
      const provided = React.useContext(QuickdrawContext);
      held.coordinator ??= provided?.coordinator;
      return null;
    }
    const view = render(
      <React.StrictMode>
        <Provider url={app.url} queryClient={queryClient}>
          <Grab />
          <Echo />
        </Provider>
      </React.StrictMode>,
    );
    await screen.findByText("user alice");
    await tick(20);
    expect(createInvalidationCoordinator(queryClient)).toBe(held.coordinator);
    view.unmount();
    await tick(20);
    expect(createInvalidationCoordinator(queryClient)).not.toBe(held.coordinator);
  });

  it("reads every query again when the server pushes new grants (qd:access)", async () => {
    const grants = new Map<string, Record<string, "Read" | "Moderate">>([
      ["alice", { probeService: "Read" }],
    ]);
    const { app, records } = await harness.start({
      auth: { ...testAuth, loadServiceAccess: (userId) => grants.get(userId) },
    });
    render(
      <Provider url={app.url}>
        <Echo />
      </Provider>,
    );
    await screen.findByText("user alice");
    const echoes = (): number => records.filter((record) => record.method === "echo").length;
    expect(echoes()).toBe(1);
    grants.set("alice", { probeService: "Moderate" });
    await act(async () => {
      await app.server.access.refresh("alice");
    });
    await until(() => echoes() === 2);
  });

  it("reports the connection with useQuickdraw, and lends it to the client's call while mounted", async () => {
    const { app } = await harness.start();
    const view = renderHook(() => useQuickdraw(), { wrapper: wrapperFor({ url: app.url }) });
    await waitFor(() => expect(view.result.current.isConnected).toBe(true));
    await waitFor(() => expect(view.result.current.hello).not.toBeNull());
    expect(view.result.current).toMatchObject({
      status: "connected",
      hello: { protocol: 5 },
      userId: "alice",
      serviceAccess: {},
      refusal: null,
      isRateLimited: false,
    });
    expect(await qd.counter.total.call()).toBe(0);
    view.unmount();
    await until(() => view.result.current.connection.getState().status === "idle");
    await expect(qd.counter.total.call()).rejects.toMatchObject({ code: "INTERNAL" });
  });

  /**
   * An app's own TanStack `useQuery` over a member's `key` and `call` (the
   * form the client rule allows for hooks the typed client has none of),
   * failing at once: no retry hides a first read that fails.
   */
  function AppTotal() {
    const total = useQuery({
      queryKey: [...qd.counter.total.key(), "app"],
      queryFn: () => qd.counter.total.call(),
      retry: false,
    });
    if (total.error !== null) {
      return (
        <p>{`refused ${String((total.error as QuickdrawError).code)}: ${total.error.message}`}</p>
      );
    }
    return <p>{total.data === undefined ? "loading" : `total ${String(total.data)}`}</p>;
  }

  it("lends the client to an app's own hook that reads in the provider's first commit, strict mode and a new provider too", async () => {
    const { app } = await harness.start();
    // The provider's direct child, mounted with it: its read starts in its own effects.
    const view = render(
      <Provider key="first" url={app.url}>
        <AppTotal />
      </Provider>,
    );
    await screen.findByText("total 0");
    // A new provider (another url makes one): the old unbinds as the new one binds, before its children read.
    view.rerender(
      <Provider key="second" url={app.url}>
        <AppTotal />
      </Provider>,
    );
    await screen.findByText("total 0");
    view.unmount();
    // Strict mode mounts effects twice: the binding is made again before the children's passive ones.
    render(
      <React.StrictMode>
        <Provider url={app.url}>
          <AppTotal />
        </Provider>
      </React.StrictMode>,
    );
    await screen.findByText("total 0");
    expect(screen.queryByText(/^refused/)).toBeNull();
  });

  it("says when the user is known and while it reconnects, and forgets the user on new credentials until their hello", async () => {
    const { app } = await harness.start();
    const seen: { isKnown: boolean; userId: string | null }[] = [];
    function Gate() {
      const { isKnown, isConnected, reconnecting, userId } = useQuickdraw();
      seen.push({ isKnown, userId });
      if (!isKnown) {
        return <p>unknown</p>;
      }
      const state = reconnecting ? "reconnecting" : isConnected ? "connected" : "offline";
      return <p>{`${userId ?? "anonymous"} ${state}`}</p>;
    }
    const view = await renderWithQuickdraw(<Gate />, { app, as: alice, client: qd });
    // Before the hello the user is not known: never shown as signed out.
    expect(seen[0]).toEqual({ isKnown: false, userId: null });
    await view.findByText("alice connected");
    await view.disconnect();
    await view.findByText("alice reconnecting");
    await view.reconnect();
    await view.findByText("alice connected");
    act(() => {
      view.connection.setAuth({ principal: bob });
    });
    expect(view.getByText("unknown")).toBeTruthy();
    await view.findByText("bob connected");
    expect(seen.some((entry) => !entry.isKnown && entry.userId !== null)).toBe(false);
  });

  it("throws a clear error for a hook rendered outside a provider", () => {
    expect(() => renderHook(() => qd.counter.read.useQuery({ name: "a" }))).toThrow(
      "counterService.read.useQuery must be rendered inside a <QuickdrawProvider>",
    );
  });
});

describe("the README's AuthGate while the server cannot authenticate", () => {
  type Gated = "sign in" | "connecting" | "reconnecting" | "app";

  /** What the README's AuthGate shows (test/readme/apps/web/src/components/AuthGate.tsx). */
  function gateOf(status: QuickdrawStatus): Gated {
    if (!status.isKnown) {
      return status.status === "disconnected" || status.status === "refused"
        ? "sign in"
        : "connecting";
    }
    if (status.userId === null) {
      return "sign in";
    }
    return status.reconnecting ? "reconnecting" : "app";
  }

  /** The gate, recording what each committed render shows. */
  function Gate({ shown }: { readonly shown: Gated[] }) {
    const gated = gateOf(useQuickdraw());
    React.useLayoutEffect(() => {
      shown.push(gated);
    });
    return gated === "app" || gated === "reconnecting" ? (
      <>
        <p>{gated}</p>
        <Echo />
      </>
    ) : (
      <p>{gated}</p>
    );
  }

  /**
   * The gate rendered against a server whose next `fail(times)` handshakes
   * are refused with what `failure` throws; `shown` records the gate.
   */
  async function failingServer(failure: () => Error, shown: Gated[]) {
    let failures = 0;
    let handshakes = 0;
    const { app } = await harness.start({
      auth: {
        authenticate: (request) => {
          handshakes += 1;
          if (failures > 0) {
            failures -= 1;
            throw failure();
          }
          return testAuth.authenticate?.(request);
        },
      },
      logger: captureLogger(),
    });
    render(
      <QuickdrawProvider
        client={qd}
        url={app.url}
        auth={{ principal: alice }}
        transports={["websocket"]}
        socketOptions={{ reconnectionDelay: 60, reconnectionDelayMax: 120 }}
      >
        <Gate shown={shown} />
      </QuickdrawProvider>,
    );
    await screen.findByText("user alice");
    return {
      fail(times: number): void {
        failures = times;
      },
      handshakes: () => handshakes,
      /** Drops every socket's transport, as a network blip does: the client reconnects. */
      drop(): void {
        for (const socket of app.server.io.sockets.sockets.values()) {
          socket.conn.close();
        }
      },
    };
  }

  it("never shows the sign-in, and keeps the page, while reconnects are refused with INTERNAL", async () => {
    const shown: Gated[] = [];
    const server = await failingServer(() => new Error("the session store is down"), shown);
    const before = server.handshakes();
    server.fail(2);
    server.drop();
    await until(() => server.handshakes() === before + 3);
    await screen.findByText("app");
    expect(screen.getByText("user alice")).toBeTruthy();
    expect(shown).toContain("reconnecting");
    expect(shown).not.toContain("sign in");
    // what the page showed stayed through the outage: the cache was kept
    expect(shown.slice(shown.indexOf("app"))).not.toContain("connecting");
  });

  it("shows the sign-in once a reconnect is refused for the session (CLIENT-1)", async () => {
    const server = await failingServer(
      () => new QuickdrawError("UNAUTHENTICATED", "The session was revoked"),
      [],
    );
    server.fail(1);
    server.drop();
    await screen.findByText("sign in");
    expect(screen.queryByText("user alice")).toBeNull();
  });
});
