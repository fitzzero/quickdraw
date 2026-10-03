// `renderWithQuickdraw` (`./testing/client`) against a real server: the
// typed client's hooks under the real provider, connected as a principal or
// anonymously, around the test's own wrapper, with a cache that does not
// retry, and a socket the test can drop and bring back.

import { QueryClient } from "@tanstack/react-query";
import * as React from "react";
import { describe, expect, it } from "vitest";
import { createQuickdrawClient } from "../client/createClient";
import { useQuickdraw } from "../client/provider";
import { alice, clientHarness, counter, probe } from "../client/__tests__/fixtures";
import { captureLogger } from "../server/__tests__/fixtures";
import { renderWithQuickdraw } from "./client";

const harness = clientHarness();
const qd = createQuickdrawClient({ counter, probe });

function Echo() {
  const { data } = qd.probe.echo.useQuery({ text: "hi" });
  return <p>{data === undefined ? "loading" : `user ${String(data.userId)}`}</p>;
}

function Failing() {
  const { error, failureCount } = qd.probe.fail.useQuery({ code: "INTERNAL" });
  return <p>{error === null ? "trying" : `failed ${error.code} after ${failureCount}`}</p>;
}

describe("renderWithQuickdraw", () => {
  it("renders the hooks under a provider connected as the principal", async () => {
    const { app } = await harness.start();
    const view = await renderWithQuickdraw(<Echo />, { app, as: alice, client: qd });
    expect(view.getByText("loading")).toBeTruthy();
    await view.findByText("user alice");
    expect(view.connection.getState()).toMatchObject({
      status: "connected",
      hello: { userId: "alice" },
    });
    expect(view.connection.url).toBe(app.url);
    expect(view.queryClient.getDefaultOptions()).toMatchObject({
      queries: { retry: false },
      mutations: { retry: false },
    });
  });

  it("connects anonymously as null, and uses the cache it is given", async () => {
    const { app } = await harness.start();
    const queryClient = new QueryClient();
    const view = await renderWithQuickdraw(<Echo />, {
      app,
      as: null,
      client: qd,
      queryClient,
    });
    await view.findByText("user null");
    expect(view.queryClient).toBe(queryClient);
    expect(queryClient.getQueryData(qd.probe.echo.key({ text: "hi" }))).toMatchObject({
      userId: null,
    });
  });

  it("renders around the provider with the wrapper, and keeps one connection across rerenders", async () => {
    const { app } = await harness.start();
    const connections = new Set<unknown>();
    function Status() {
      const { connection, isConnected } = useQuickdraw();
      connections.add(connection);
      return <p>{isConnected ? "online" : "offline"}</p>;
    }
    const view = await renderWithQuickdraw(<Status />, {
      app,
      as: alice,
      client: qd,
      wrapper: React.StrictMode,
    });
    await view.findByText("online");
    view.rerender(<Echo />);
    await view.findByText("user alice");
    expect([...connections]).toEqual([view.connection]);
  });

  it("keeps a query hook's own retry policy, one more attempt after INTERNAL, without the delay", async () => {
    // The server logs each INTERNAL at error; keep the test's output quiet.
    const { app, records } = await harness.start({ logger: captureLogger() });
    const view = await renderWithQuickdraw(<Failing />, { app, as: alice, client: qd });
    // TanStack's default delay before that attempt is 2 s.
    await view.findByText("failed INTERNAL after 2", undefined, { timeout: 1500 });
    expect(records.map((record) => record.outcome)).toEqual(["INTERNAL", "INTERNAL"]);
  });

  it("drops the socket on disconnect(), and brings it back on reconnect()", async () => {
    const { app } = await harness.start();
    const view = await renderWithQuickdraw(<Echo />, { app, as: alice, client: qd });
    await view.findByText("user alice");
    const first = view.connection.socket.id ?? "";
    expect(app.server.io.sockets.sockets.has(first)).toBe(true);

    await view.disconnect();
    expect(app.server.io.sockets.sockets.has(first)).toBe(false);
    expect(view.connection.getState()).toMatchObject({ status: "connecting", reconnecting: true });
    // Socket.IO's own reconnection is held until reconnect(), and what was shown stays.
    expect(view.connection.socket.io.reconnection()).toBe(false);
    await new Promise((resolve) => {
      setTimeout(resolve, 300);
    });
    expect(view.connection.socket.connected).toBe(false);
    expect(view.getByText("user alice")).toBeTruthy();
    await expect(view.disconnect()).rejects.toThrow("disconnect() needs a connected socket");

    await view.reconnect();
    expect(view.connection.getState()).toMatchObject({ status: "connected", reconnecting: false });
    expect(view.connection.socket.io.reconnection()).toBe(true);
    expect(view.connection.socket.id).not.toBe(first);
    expect(app.frames({ event: "qd:hello", userId: "alice" })).toHaveLength(2);
    await expect(view.reconnect()).rejects.toThrow("reconnect() needs a socket dropped");
  });
});

// This file never imports Testing Library itself, so its first import is the
// lazy one inside a test, too late for its own cleanup to register.
describe("after each test", () => {
  it("renders a view, and leaves it for the cleanup", async () => {
    const { app } = await harness.start();
    const view = await renderWithQuickdraw(<p>left behind</p>, { app, as: alice, client: qd });
    expect(view.getByText("left behind")).toBeTruthy();
  });

  it("finds the view unmounted and its container gone", () => {
    expect(document.body.textContent).not.toContain("left behind");
    expect(document.body.children).toHaveLength(0);
  });
});
