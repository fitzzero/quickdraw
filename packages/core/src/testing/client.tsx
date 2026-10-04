// Client test helpers: @fitzzero/quickdraw-core/testing/client (RFC 0003
// section 13). Components that use the typed client are tested against a
// real in-process server, or against a mock client with no server at all.
//
// 4.1's `./client/testing` could not work as documented: `createTestWrapper`
// filled a context of its own (`legacy-src/client/testing.tsx:185-192`)
// while the hooks read the provider's unexported one
// (`legacy-src/client/QuickdrawProvider.tsx:169`), and every hook test
// mocked the provider, so no test ran a hook against a server. Here:
//
// - `renderWithQuickdraw(ui, { app, as, client })` renders `ui` under the
//   real `QuickdrawProvider`, connected over a real socket to a test app
//   (`createTestApp`, which boots the app's services on `createServer`) as
//   the principal `as`. The hooks run as they do in the app: the same
//   connection, calls, change topics, coordinator and live data.
// - `createMockClient(contracts)` (`mockClient.ts`) is a client of the same
//   type whose members are stubs, for component tests that do not care
//   about the transport. It is its own entry too, `./testing/mock`, which
//   a browser bundle (Storybook) can import: this one names Testing Library.
//
// The published package does not depend on Testing Library: it is an
// optional peer, imported only when `renderWithQuickdraw` runs, so a test
// that uses `createMockClient` alone loads neither Testing Library nor any
// server code. No "use client" directive: this entry is for tests, never
// for a bundle that React Server Components split.

import { QueryClient } from "@tanstack/react-query";
import type { RenderResult } from "@testing-library/react";
import * as React from "react";
import type { QuickdrawClient } from "../client/clientTypes";
import type { QuickdrawConnection } from "../client/connection";
import { QuickdrawContext } from "../client/context";
import { QuickdrawProvider } from "../client/provider";
import type { ContractMap } from "../contract/infer";
import type { PrincipalOfServices } from "../server/dispatcher";
import type { AnyService } from "../server/service";
import type { TestApp } from "./createTestApp";

export * from "./mock";
export { installJsdomShims } from "./jsdom";

/** Options of {@link renderWithQuickdraw}. */
export interface RenderWithQuickdrawOptions<
  S extends readonly AnyService[],
  Contracts extends ContractMap,
> {
  /** The test app to connect to, from `createTestApp`. */
  readonly app: TestApp<S>;
  /**
   * Who the socket acts for, or `null` for an anonymous socket. It is sent
   * as the handshake's `principal`, which a test app trusts unless it was
   * given an `authenticate` of its own.
   */
  readonly as: PrincipalOfServices<S> | null;
  /** The client the components use, from `createQuickdrawClient`. */
  readonly client: QuickdrawClient<Contracts>;
  /**
   * The cache the hooks use. Default: a fresh one with the provider's
   * defaults (results fresh for 5 minutes, no refetch on window focus) and
   * retries off.
   */
  readonly queryClient?: QueryClient;
  /** Components to render around the provider: the app's own providers, or `React.StrictMode`. */
  readonly wrapper?: React.JSXElementConstructor<{ readonly children: React.ReactNode }>;
}

/** What {@link renderWithQuickdraw} resolves with: Testing Library's render result, and more. */
export interface QuickdrawRenderResult extends RenderResult {
  /** The provider's connection. */
  readonly connection: QuickdrawConnection;
  /** The provider's cache. */
  readonly queryClient: QueryClient;
  /**
   * Drops the socket the way a lost network does, and holds Socket.IO's
   * automatic reconnection until `reconnect()`. The connection is
   * `reconnecting` meanwhile and keeps everything it holds; the server
   * forgets the socket and its rooms. Resolves once the server has dropped it.
   */
  disconnect(): Promise<void>;
  /**
   * Lets a socket dropped by `disconnect()` connect again: as after a real
   * outage, the connection joins its topics again, refetches what may have
   * changed and resumes its live data by revision. Resolves once it is
   * connected and the server's new `qd:hello` has arrived.
   */
  reconnect(): Promise<void>;
}

const TIMEOUT_MS = 5000;

/** Testing Library, once `renderWithQuickdraw` has loaded it. */
let testingLibrary: typeof import("@testing-library/react") | undefined;

/** True when `RTL_SKIP_AUTO_CLEANUP` turns Testing Library's automatic cleanup off. */
function skipsAutoCleanup(): boolean {
  return typeof process !== "undefined" && Boolean(process.env.RTL_SKIP_AUTO_CLEANUP);
}

// Testing Library unmounts what it rendered after each test when the test
// runner has a global `afterEach`, but it registers that cleanup when it is
// first imported. Imported lazily here, that can be inside a test, where it
// is too late to register; so this module registers the same cleanup when
// it loads, as Testing Library does, and honors `RTL_SKIP_AUTO_CLEANUP`.
// Running it twice (Testing Library's own and this one) is harmless.
const runnerAfterEach: unknown = (globalThis as { readonly afterEach?: unknown }).afterEach;
if (typeof runnerAfterEach === "function" && !skipsAutoCleanup()) {
  (runnerAfterEach as (cleanup: () => void) => void)(() => {
    testingLibrary?.cleanup();
  });
}

/**
 * The cache `renderWithQuickdraw` makes: the provider's defaults, with
 * retries off. A quickdraw query hook keeps its own retry policy (one more
 * attempt after `INTERNAL`) unless it is given `retry`; here that attempt
 * follows at once.
 */
function createTestQueryClient(): QueryClient {
  return new QueryClient({
    defaultOptions: {
      queries: {
        staleTime: 5 * 60 * 1000,
        refetchOnWindowFocus: false,
        retry: false,
        retryDelay: 0,
      },
      mutations: { retry: false },
    },
  });
}

/**
 * Resolves once `ready()` holds, checking now and on every `subscribe`
 * notification; rejects after `TIMEOUT_MS` naming what it waited for.
 */
function waitUntil(
  ready: () => boolean,
  subscribe: (notify: () => void) => () => void,
  what: string,
): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    let stop = (): void => undefined;
    const timer = setTimeout(() => {
      stop();
      reject(new Error(`renderWithQuickdraw: ${what} within ${TIMEOUT_MS} ms`));
    }, TIMEOUT_MS);
    const check = (): void => {
      if (ready()) {
        clearTimeout(timer);
        stop();
        resolve();
      }
    };
    stop = subscribe(check);
    check();
  });
}

/** The provider's connection, kept by the first render of a component under it. */
interface Grabbed {
  connection: QuickdrawConnection | null;
}

/** Testing Library's `act`: what React does meanwhile is applied before it resolves. */
type Act = (callback: () => Promise<void>) => Promise<void>;

/**
 * `disconnect()` and `reconnect()` of one rendered connection. Each runs in
 * `act`, so the re-renders the connection's state changes cause are applied
 * within it, as React expects in a test.
 */
function outages<S extends readonly AnyService[]>(
  app: TestApp<S>,
  connection: QuickdrawConnection,
  act: Act,
): Pick<QuickdrawRenderResult, "disconnect" | "reconnect"> {
  const manager = connection.socket.io;
  let reconnection = manager.reconnection();
  const drop = async (id: string): Promise<void> => {
    const dropped = app.server.io.sockets.sockets.get(id);
    reconnection = manager.reconnection();
    manager.reconnection(false);
    manager.engine.close();
    await waitUntil(
      () => !app.server.io.sockets.sockets.has(id),
      (notify) => {
        dropped?.once("disconnect", notify);
        return () => dropped?.off("disconnect", notify);
      },
      "the server did not drop the socket",
    );
  };
  const bringBack = async (): Promise<void> => {
    const before = connection.getState().hello;
    manager.reconnection(reconnection);
    connection.socket.connect();
    await waitUntil(
      () => {
        const state = connection.getState();
        return state.status === "connected" && state.hello !== null && state.hello !== before;
      },
      connection.subscribe,
      "the socket did not connect again",
    );
  };
  return {
    async disconnect() {
      const { id } = connection.socket;
      if (!connection.socket.connected || id === undefined) {
        throw new Error("renderWithQuickdraw: disconnect() needs a connected socket");
      }
      await act(async () => {
        await drop(id);
      });
    },
    async reconnect() {
      if (connection.socket.connected) {
        throw new Error("renderWithQuickdraw: reconnect() needs a socket dropped by disconnect()");
      }
      await act(bringBack);
    },
  };
}

/**
 * Renders `ui` with Testing Library under a `QuickdrawProvider` for
 * `client`, connected to the test app `app` over a real socket as `as`, with
 * a fresh `QueryClient` (retries off) unless one is given. Resolves with
 * Testing Library's render result plus the provider's `connection` and
 * `queryClient`, and `disconnect()` / `reconnect()` to drop the socket and
 * bring it back. Testing Library unmounts it after each test, as it does
 * everything `render` renders; an unmounted provider closes its connection.
 *
 * Needs a DOM (jsdom or happy-dom) and `@testing-library/react`.
 *
 * @example
 * const app = await createTestApp({ services: [taskService], db });
 * const view = await renderWithQuickdraw(<TaskTitle id={id} />, { app, as: ada, client: qd });
 * await view.findByText("Write the spec");
 * await app.as(bo).taskService.rename({ id, title: "Ship it" });
 * await view.findByText("Ship it");
 */
export async function renderWithQuickdraw<
  const S extends readonly AnyService[],
  const Contracts extends ContractMap,
>(
  ui: React.ReactElement,
  options: RenderWithQuickdrawOptions<S, Contracts>,
): Promise<QuickdrawRenderResult> {
  testingLibrary ??= await import("@testing-library/react");
  const { render, act } = testingLibrary;
  const { app, client } = options;
  const queryClient = options.queryClient ?? createTestQueryClient();
  const auth = options.as === null ? undefined : { principal: options.as };
  const Outer = options.wrapper ?? React.Fragment;
  const grabbed: Grabbed = { connection: null };
  // Reads the context, not `useQuickdraw()`, so it never re-renders when the
  // connection's state changes.
  function Grab(): null {
    const provided = React.useContext(QuickdrawContext);
    grabbed.connection ??= provided?.connection ?? null;
    return null;
  }
  function Wrapper({ children }: { readonly children?: React.ReactNode }): React.ReactElement {
    return (
      <Outer>
        <QuickdrawProvider
          client={client}
          url={app.url}
          auth={auth}
          transports={["websocket"]}
          queryClient={queryClient}
        >
          <Grab />
          {children}
        </QuickdrawProvider>
      </Outer>
    );
  }
  const view = render(ui, { wrapper: Wrapper });
  const { connection } = grabbed;
  if (connection === null) {
    view.unmount();
    throw new Error("renderWithQuickdraw: the provider did not render");
  }
  return { ...view, connection, queryClient, ...outages(app, connection, act) };
}
