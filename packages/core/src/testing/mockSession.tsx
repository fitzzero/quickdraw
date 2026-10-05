// The session of a mock client (`mockClient.ts`, RFC 0003 section 13): who
// the mock acts for, as the real `useQuickdraw()` and `usePresence(room)`
// read it under the mock's provider (`mock.$Provider`), with no server and
// no socket. 4.1 had nothing of the kind, and an app on the first 5.0
// candidates re-exported `useQuickdraw` from the module it mocked, so that a
// story or a test could fake the connection state (finding F3.1).
//
// - The provider fills the same context `QuickdrawProvider` fills, with a
//   connection that never opens: its state is made from the session (a
//   hello naming `userId` with `serviceAccess`, connected or connecting,
//   known or not), and every hook that reads the context reads it, on a
//   server too (`renderOnServerAs`).
// - `usePresence(room)` shows the users `$presence(room, users)` set, while
//   the session is known (a socket is in no room before its hello).
// - The views of the mock's collections select members for the session's
//   user, as the real ones do for the user the hello names.
// - `<mock.$Provider session={...}>` lays its `session` over the mock's for
//   what renders inside it (finding F6.2): its own connection shows that
//   session, and the mock's hooks read it from `mockScope.ts`, so stories
//   rendered side by side (a Storybook docs page) each show their own.
//
// Imports nothing of Testing Library, so a browser bundle (Storybook) can
// take it: `./testing/mock` is its own entry.

import { QueryClientProvider, type QueryClient } from "@tanstack/react-query";
import { useMemo, type ReactElement, type ReactNode } from "react";
import {
  createQuickdrawConnection,
  type ConnectionState,
  type QuickdrawConnection,
} from "../client/connection";
import { QuickdrawContext, renderOnServerAs, type QuickdrawContextValue } from "../client/context";
import { createInvalidationCoordinator, type InvalidationCoordinator } from "../client/coordinator";
import { inertLiveData } from "../client/live/liveData";
import type { PresenceStore } from "../client/live/presence";
import { MAX_SUBSCRIBE_IDS, PROTOCOL_VERSION, type HelloFrame } from "../protocol/version";
import { QUICKDRAW_VERSION } from "../version";
import type { MockStore } from "./mockLive";
import { MockSessionScope, type ScopedSession, type SessionScope } from "./mockScope";
import type { MockClientOptions, MockSession, SessionState } from "./mockTypes";

/** The URL of a mock's connection, which never opens. */
const MOCK_URL = "http://quickdraw-mock.invalid";

const NOBODY: readonly string[] = Object.freeze([]);

/** The limits a mock's hello announces: the server's defaults. */
const MOCK_LIMITS: HelloFrame["limits"] = Object.freeze({
  maxInFlightQueries: 16,
  maxQueuedQueries: 64,
  maxSubscribeIds: MAX_SUBSCRIBE_IDS,
  callTimeoutMs: 30_000,
  subscriptions: Object.freeze({ maxInFlight: 8, maxQueued: 64 }),
});

function checkUser(owner: string, userId: unknown): string | null | undefined {
  if (userId === undefined || userId === null || (typeof userId === "string" && userId !== "")) {
    return userId;
  }
  throw new TypeError(`${owner}: userId must be a non-empty string, or null for an anonymous user`);
}

function checkFlag(owner: string, name: string, value: unknown): boolean | undefined {
  if (value === undefined || typeof value === "boolean") {
    return value;
  }
  throw new TypeError(`${owner}: ${name} must be true or false`);
}

/**
 * `session` over `base`: what it sets replaces what `base` has, field by
 * field; a field it leaves out (or sets to `undefined`) keeps `base`'s.
 * Throws a `TypeError` naming `owner` for a field of the wrong kind.
 */
export function sessionOver(
  owner: string,
  base: SessionState,
  session: MockSession | undefined,
): SessionState {
  if (session === undefined) {
    return base;
  }
  if (typeof session !== "object" || session === null) {
    throw new TypeError(
      `${owner}: the session is { userId?, serviceAccess?, isConnected?, isKnown? }`,
    );
  }
  const { serviceAccess } = session;
  if (
    serviceAccess !== undefined &&
    (typeof serviceAccess !== "object" || serviceAccess === null)
  ) {
    throw new TypeError(`${owner}: serviceAccess maps service names to access levels`);
  }
  const userId = checkUser(owner, session.userId);
  const isConnected = checkFlag(owner, "isConnected", session.isConnected);
  const isKnown = checkFlag(owner, "isKnown", session.isKnown);
  return Object.freeze({
    userId: userId === undefined ? base.userId : userId,
    serviceAccess: Object.freeze({ ...(serviceAccess ?? base.serviceAccess) }),
    isConnected: isConnected ?? base.isConnected,
    isKnown: isKnown ?? base.isKnown,
  });
}

/** The id a mock's hello names its server by: one mock server, never restarted. */
const MOCK_SERVER_ID = "mock";

/** The connection state a session shows: connected or connecting, with a hello once it is known. */
function stateOf(session: SessionState): ConnectionState {
  const hello: HelloFrame | null = session.isKnown
    ? Object.freeze({
        protocol: PROTOCOL_VERSION,
        server: QUICKDRAW_VERSION,
        serverId: MOCK_SERVER_ID,
        limits: MOCK_LIMITS,
        features: Object.freeze([]),
        userId: session.userId,
        serviceAccess: session.serviceAccess,
      })
    : null;
  return Object.freeze({
    status: session.isConnected ? "connected" : "connecting",
    reconnecting: !session.isConnected && session.isKnown,
    hello,
    serviceAccess: hello === null ? null : session.serviceAccess,
    refusal: null,
    backoff: Object.freeze({}),
  });
}

/**
 * The connection of a mock client: a real connection that is never opened
 * (its socket, lane and topics stay idle, so a real client's hook rendered
 * under the mock's provider by mistake waits rather than throws), whose
 * state comes from the mock's session. Opening, closing and new credentials
 * do nothing.
 */
function mockConnection(store: MockStore, sessionOf: () => SessionState): QuickdrawConnection {
  const inert = createQuickdrawConnection({ url: MOCK_URL, transports: ["websocket"] });
  let shown: { readonly session: SessionState; readonly state: ConnectionState } | undefined;
  const getState = (): ConnectionState => {
    const session = sessionOf();
    if (shown?.session !== session) {
      shown = { session, state: stateOf(session) };
    }
    return shown.state;
  };
  const nothing = (): void => undefined;
  return Object.freeze({
    url: inert.url,
    timeoutMs: inert.timeoutMs,
    socket: inert.socket,
    subscriptionLane: inert.subscriptionLane,
    getState,
    subscribe: store.subscribe,
    open: nothing,
    close: nothing,
    retain: () => nothing,
    setAuth: () => false,
    nextCallId: inert.nextCallId,
    reportRateLimited: nothing,
    backoffRemaining: () => 0,
    onReconnect: () => nothing,
    onHello: (listener: (hello: HelloFrame) => void) => mockHellos(getState, store, listener),
    watch: () => nothing,
    waitForJoin: () => undefined,
  });
}

/**
 * `onHello` on a mock's connection: each session that is connected and
 * known is a hello (`$session(...)` that sets one is a reconnect), the
 * current one in a microtask, as a real connection gives it.
 */
function mockHellos(
  getState: () => ConnectionState,
  store: MockStore,
  listener: (hello: HelloFrame) => void,
): () => void {
  let last: HelloFrame | null = null;
  let stopped = false;
  const deliver = (): void => {
    const { status, hello } = getState();
    if (!stopped && status === "connected" && hello !== null && hello !== last) {
      last = hello;
      listener(hello);
    }
  };
  queueMicrotask(deliver);
  const stop = store.subscribe(deliver);
  return () => {
    stopped = true;
    stop();
  };
}

/** The key of a room's users in the mock's store. */
function presenceKey(room: string): string {
  return `presence\u0000${room}`;
}

/**
 * The presence `usePresence` reads on a mock: the users the test set per
 * room, nobody while the session is not known. No frame reaches it.
 */
function mockPresence(store: MockStore, sessionOf: () => SessionState): PresenceStore {
  return Object.freeze({
    users(room: string): readonly string[] {
      if (!sessionOf().isKnown) {
        return NOBODY;
      }
      return (store.value(presenceKey(room)) as readonly string[] | undefined) ?? NOBODY;
    },
    // Every change of the store: `users` returns the same array until the room's own changes.
    listen: (_room: string, listener: () => void) => store.subscribe(listener),
    receive: () => undefined,
    clear: () => undefined,
  });
}

/** What a mock client gives its tests besides its members: its provider, session and presence. */
/** The props of a mock's provider: what it renders, and the session it shows there. */
export interface MockProviderProps {
  readonly children?: ReactNode;
  /**
   * The session the subtree shows, laid over the mock's own (`$session`)
   * field by field: what it leaves out follows the mock's. Each provider
   * has its own, so stories rendered side by side show their own sessions.
   */
  readonly session?: MockSession;
}

export interface MockSessionControls {
  readonly Provider: (props: MockProviderProps) => ReactElement;
  /** The invalidation coordinator of the mock's cache, which the provider gives the hooks too. */
  readonly coordinator: InvalidationCoordinator;
  setSession(session: MockSession): void;
  setPresence(room: string, users: readonly string[]): void;
}

/** The session a mock starts with: its `session` option over `userId`, connected and known. */
export function startingSession(options: MockClientOptions): SessionState {
  const fallback: SessionState = Object.freeze({
    userId: null,
    serviceAccess: Object.freeze({}),
    isConnected: true,
    isKnown: true,
  });
  const withUser = sessionOver(
    "createMockClient",
    fallback,
    options.userId === undefined ? undefined : { userId: options.userId },
  );
  return sessionOver("createMockClient", withUser, options.session);
}

/**
 * `session` laid over the session of `store` (`$Provider`'s prop): checked
 * at once, and the same object while the mock's own session does not change.
 */
function scopeOf(store: MockStore, session: MockSession): SessionScope {
  sessionOver("$Provider", store.session(), session);
  let last: { readonly base: SessionState; readonly shown: SessionState } | undefined;
  return (base) => {
    if (last?.base !== base) {
      last = { base, shown: sessionOver("$Provider", base, session) };
    }
    return last.shown;
  };
}

/**
 * The provider, session and presence of one mock client: `base` is the
 * session it starts with and goes back to on a reset; `$session` sets
 * another over it.
 */
export function mockSessionControls(
  store: MockStore,
  queryClient: QueryClient,
  base: SessionState,
): MockSessionControls {
  const coordinator = createInvalidationCoordinator(queryClient);
  /** The context value of a connection showing `sessionOf`'s session. */
  const contextOver = (sessionOf: () => SessionState): QuickdrawContextValue => {
    const connection = mockConnection(store, sessionOf);
    // A server renders the session too, so a story or a test that renders on one hydrates it.
    renderOnServerAs(connection, connection.getState);
    inertLiveData(connection, queryClient, mockPresence(store, sessionOf));
    return Object.freeze({ connection, queryClient, coordinator });
  };
  const value = contextOver(store.session);
  /** A provider's `session` prop: its own connection, and the scope the mock's hooks read. */
  const scopedBy = (key: string): { value: QuickdrawContextValue; scoped: ScopedSession } => {
    const scope = scopeOf(store, JSON.parse(key) as MockSession);
    return {
      value: contextOver(() => scope(store.session())),
      scoped: Object.freeze({ store, scope }),
    };
  };
  function MockQuickdrawProvider({ children, session }: MockProviderProps): ReactElement {
    // By value: a story passes a new object on every render.
    const key = session === undefined ? undefined : JSON.stringify(session);
    const scoped = useMemo(() => (key === undefined ? undefined : scopedBy(key)), [key]);
    return (
      <QueryClientProvider client={queryClient}>
        <QuickdrawContext.Provider value={scoped?.value ?? value}>
          <MockSessionScope.Provider value={scoped?.scoped}>{children}</MockSessionScope.Provider>
        </QuickdrawContext.Provider>
      </QueryClientProvider>
    );
  }
  return Object.freeze({
    Provider: MockQuickdrawProvider,
    coordinator,
    setSession(session: MockSession): void {
      store.setSession(sessionOver("$session", base, session));
    },
    setPresence(room: string, users: readonly string[]): void {
      if (typeof room !== "string" || room === "") {
        throw new TypeError("$presence: room must be a room's name");
      }
      if (!Array.isArray(users) || !users.every((user) => typeof user === "string")) {
        throw new TypeError("$presence: users must be a list of user ids");
      }
      store.setValue(presenceKey(room), Object.freeze([...new Set(users)]));
    },
  });
}
