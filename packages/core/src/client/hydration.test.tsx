// Hydrating what a server rendered (finding F3.5): the hooks that read the
// connection hydrate with the state a server renders (a connection that
// never opened), never with the live state, so a boundary that hydrates
// after the provider connected (here a Suspense boundary that waits for the
// server's hello, as a lazy route or a slow chunk does) matches the
// server's HTML, and shows the live state in the next render.

import { act, waitFor } from "@testing-library/react";
import * as React from "react";
import { hydrateRoot, type Root } from "react-dom/client";
import { renderToString } from "react-dom/server";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { QuickdrawConnection } from "./connection";
import { QuickdrawContext } from "./context";
import { createQuickdrawClient } from "./createClient";
import { usePresence } from "./live/usePresence";
import { QuickdrawProvider, useQuickdraw } from "./provider";
import { alice, clientHarness, counter, probe } from "./__tests__/fixtures";

const harness = clientHarness();
const qd = createQuickdrawClient({ counter, probe });

/** What the page shows of the connection: who, whether known, the lobby, a query. */
function Status() {
  const { isKnown, isConnected, userId } = useQuickdraw();
  const lobby = usePresence("lobby");
  const total = qd.counter.total.useQuery();
  const who = isKnown ? `user ${String(userId)}` : "connecting";
  return (
    <p>{`${who} ${isConnected ? "online" : "offline"} lobby:${String(lobby.length)} total:${total.status}`}</p>
  );
}

/** Resolves once the provider's connection has the server's hello: one promise per connection. */
const hellos = new WeakMap<QuickdrawConnection, Promise<void>>();
function helloOf(connection: QuickdrawConnection): Promise<void> {
  let hello = hellos.get(connection);
  if (hello === undefined) {
    hello = new Promise<void>((resolve) => {
      const check = (): void => {
        if (connection.getState().hello !== null) {
          stop();
          resolve();
        }
      };
      const stop = connection.subscribe(check);
      check();
    });
    hellos.set(connection, hello);
  }
  return hello;
}

/** Renders its children once the connection's hello arrived: the boundary hydrates after the provider connected. */
function AfterHello({ children }: { readonly children: React.ReactNode }) {
  const provided = React.useContext(QuickdrawContext);
  if (provided === null) {
    throw new Error("AfterHello needs the provider");
  }
  React.use(helloOf(provided.connection));
  return children;
}

function Page({ url, late }: { readonly url: string; readonly late: boolean }) {
  return (
    <QuickdrawProvider client={qd} url={url} auth={{ principal: alice }} transports={["websocket"]}>
      <React.Suspense fallback={<p>loading</p>}>
        {late ? (
          <AfterHello>
            <Status />
          </AfterHello>
        ) : (
          <Status />
        )}
      </React.Suspense>
    </QuickdrawProvider>
  );
}

let root: Root | undefined;

afterEach(() => {
  act(() => {
    root?.unmount();
  });
  root = undefined;
  document.body.innerHTML = "";
});

describe("hydration", () => {
  it("hydrates a boundary that waited for the hello with what the server rendered, then shows the live state", async () => {
    const { app } = await harness.start();
    const html = renderToString(<Page url={app.url} late={false} />);
    // A server never connects: nobody is known yet, and the query has not run.
    expect(html).toContain("connecting offline lobby:0 total:pending");
    const container = document.createElement("div");
    container.innerHTML = html;
    document.body.append(container);
    const recoverable: unknown[] = [];
    const errors = vi.spyOn(console, "error");
    await act(async () => {
      root = hydrateRoot(container, <Page url={app.url} late />, {
        onRecoverableError: (error) => {
          recoverable.push(error);
        },
      });
      await Promise.resolve();
    });
    await waitFor(() => {
      expect(container.textContent).toBe("user alice online lobby:0 total:success");
    });
    expect(recoverable).toEqual([]);
    expect(errors.mock.calls.filter((call) => /hydrat/i.test(String(call[0])))).toEqual([]);
    errors.mockRestore();
  });
});
