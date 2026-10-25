// `createServer` (RFC 0003 sections 3, 8 and 10): serves a dispatcher over
// Socket.IO and HTTP, on the Express app and HTTP server the app already
// owns. It replaces 4.1's `createQuickdrawServer`, which built its own
// Express app and listened itself (4.1 `src/server/createServer.ts:57-67`),
// so every app that needed its own middleware copied the whole bootstrap
// instead, and which called `process.exit` on shutdown (`:195-204`). This one
// creates the HTTP server only when none is passed, never listens, never exits
// the process, and handles signals only when asked.

import {
  createServer as createHttpServer,
  type IncomingMessage,
  type Server as HttpServer,
  type ServerResponse,
} from "node:http";
import { consoleLogger, type Logger } from "../contract/logger";
import {
  createDispatcher,
  detachDispatcher,
  loopsOf,
  withServerParts,
  type Dispatcher,
  type DispatcherBaseOptions,
  type PrincipalOfServices,
} from "./dispatcher";
import {
  liveOf,
  type HostLeaveHandler,
  type HostLeaveHook,
  type RoomLeaveHandler,
  type RoomLeaveHook,
} from "./emit/live";
import {
  closer,
  prepareWatchdog,
  startStartupChecks,
  trackCalls,
  watchSignals,
  type ServerWatchdog,
  type StallWatchdogOptions,
} from "./lifecycle";
import { editsGrants, type AnyService } from "./service";
import {
  createGrantsSink,
  createPrincipalResolver,
  socketAuthOf,
  type ServerAuth,
  type ServiceGrants,
} from "./transports/auth";
import {
  checkHttpTransportOptions,
  httpRouter,
  httpRouterSettings,
  type HttpRouter,
  type HttpTransportOptions,
} from "./transports/http";
import {
  checkKeyPrefix,
  createSocketServer,
  type ClusterOptions,
  type DisconnectUserOptions,
  resolveLegacyWire,
  type LegacyWireOptions,
  type QuickdrawIo,
  type SocketCors,
  type SocketOptions,
  type SocketRateLimitOptions,
  type SocketServer,
  type SocketServerSettings,
} from "./transports/socketServer";
import type { Principal } from "./types";

export { startupChecksOf } from "./lifecycle";

/**
 * The parts of an Express app (4 or 5) `createServer` uses: it is a request
 * listener, and `use` mounts the HTTP transport.
 */
export interface HttpApp {
  (req: IncomingMessage, res: ServerResponse): void;
  use(router: HttpRouter): unknown;
}

/** `createServer`'s own options, besides the dispatcher's. */
export interface ServerOnlyOptions<P extends Principal = Principal> {
  /**
   * The app's Express app. The HTTP transport is mounted on it with
   * `app.use`, and when `httpServer` is not given the HTTP server is created
   * from it. Mount the app's own routes and parsers first.
   */
  readonly app?: HttpApp;
  /**
   * The app's HTTP server, for Socket.IO to attach to; pass the one made from
   * `app`, and `app` with it (or `http: false`): the HTTP transport is
   * mounted on `app`. Without it one is created, from `app` when given.
   * Either way the app calls `server.httpServer.listen(...)` itself.
   */
  readonly httpServer?: HttpServer;
  /** Authenticates sockets and HTTP calls. Without it every caller is anonymous. */
  readonly auth?: ServerAuth<P>;
  /** Socket.IO's CORS for its handshake. The app configures CORS for its own routes. */
  readonly cors?: SocketCors;
  /**
   * Other Socket.IO server options, such as `path` or `pingInterval`.
   * `connectionStateRecovery` is refused: a recovered socket would come back
   * with its principal and rooms without authenticating again, so a revoked
   * session or a lowered grant would return; quickdraw clients resume by
   * revision on every reconnect.
   */
  readonly socket?: SocketOptions;
  /**
   * Use the stock Socket.IO parser, so events may carry binary. Default
   * `false`: the JSON-only parser, which also measures each reply's size.
   */
  readonly binary?: boolean;
  /**
   * Serve 4.x clients, which connect without `auth.qd`, through the legacy
   * shim: request/response calls only. Default `false`: they are refused with
   * `PROTOCOL_MISMATCH`. `{ aliases: { taskService: "cardService" } }` also
   * serves a renamed service under its old name, to 4.x clients only, and
   * logs each caller of an old name once.
   */
  readonly legacyWire?: boolean | LegacyWireOptions;
  /**
   * The socket rate limiter (`createRateLimiter`'s options), or `false` for
   * none. Default: 600 events per minute per socket. `qd:ch` (channels keep
   * their own per-socket token buckets), `qd:cancel`, the entity and
   * collection subscription events (`qd:sub`, `qd:unsub`, `qd:col:sub`,
   * `qd:col:unsub`, `qd:col:items`), the topic watches (`qd:watch`,
   * `qd:unwatch`), the stream subscriptions (`qd:stream:sub`,
   * `qd:stream:unsub`) and peer link relay messages (`qd:relay`, which keep
   * their own buckets) are never counted; the ones that read run in a
   * per-socket lane instead (`limits.subscriptions`: 8 at once, 64 waiting,
   * then `RATE_LIMITED`).
   */
  readonly rateLimit?: SocketRateLimitOptions | false;
  /**
   * The HTTP transport's options, or `false` to serve no HTTP calls. It has
   * no rate limit unless `rateLimit` is given: `http: { rateLimit:
   * createCallLimiter() }` (from `./server/express`).
   */
  readonly http?: HttpTransportOptions | false;
  /** Close the server on `SIGTERM` and `SIGINT`. Default `false`. The process is never exited. */
  readonly handleSignals?: boolean;
  /**
   * Watch the event loop for stalls: sample its delay (every 20 ms), read it
   * every `intervalMs` (10 s), and log a warning naming the window's slowest
   * methods when the 99th percentile delay is above `thresholdMs` (200 ms)
   * or one delay is above `maxMs` (1 s). `true` for the defaults. Default
   * `false`. Stops on `close()`.
   */
  readonly stallWatchdog?: boolean | StallWatchdogOptions;
  /**
   * How long `close()` waits for calls and HTTP requests in flight before it
   * stops waiting and closes their connections, in milliseconds. Default
   * 10,000.
   */
  readonly shutdownTimeoutMs?: number;
  /**
   * Behind a cluster adapter: where the cluster's shared state lives (the
   * revision counter every node's flushes take their revision from, and
   * users' last-seen times). By default the Socket.IO Redis adapter's own
   * Valkey or Redis client, under keys prefixed `quickdraw:`. Its
   * `keyPrefix` also names the deployment every server-to-server event
   * carries (a node ignores another deployment's) and is
   * `setupRedisAdapter`'s default key: each deployment sharing a Valkey
   * needs its own. See `docs/deploying.md`.
   */
  readonly cluster?: ClusterOptions;
  /**
   * Called once for every socket that leaves app rooms: its own
   * `ctx.rooms.leave(room)` (`reason: "leave"`), `rooms.leave(room, { userId })`
   * (`"removed"`), or a disconnect, which leaves every app room it was in
   * (`"disconnect"`). It gets the socket's principal (`null` when
   * anonymous), its id and the rooms it left, each with `last`: true when
   * no socket of that user is in the room any more, on any node (a second
   * tab keeps it false; a socket reconnecting after `qd:rotate` is a new
   * socket, so the old one's disconnect is the user's last only if they had
   * no other). It runs on the node that held the socket, after the room
   * heard the socket go, in a unit of work of its own (`qd.run` with
   * `detached`: never the unit of the handler that left), with that run's
   * `ctx`; an error it throws is logged, and `close()` waits for it.
   *
   * A service that joins sockets to rooms declares its own hook instead
   * (`defineService`'s `onRoomLeave`), so no server root can forget it:
   * every service's hook runs beside this one, each in a unit of work of
   * its own, and one that throws stops none of the others.
   *
   * @example
   * onRoomLeave: ({ principal, rooms }) => {
   *   if (principal !== null && rooms.some(({ room, last }) => room === WORLD_ROOM && last)) {
   *     removePlayer(principal.userId);
   *     qd.rooms.emit(WORLD_ROOM, gameContract, "playerLeft", { id: principal.userId });
   *   }
   * },
   */
  readonly onRoomLeave?: RoomLeaveHandler<P>;
  /**
   * Called once when the host of an app room leaves it (host mode): its own
   * leave, a removal or a disconnect. Every service's own `onHostLeave` runs
   * beside it, as for `onRoomLeave`. The room has no host until a method
   * sets one again.
   */
  readonly onHostLeave?: HostLeaveHandler<P>;
  /**
   * Serve peer links (RFC 0003 section 12.5): two sockets of one app room
   * open WebRTC data channels between them (`createPeerLink` on the
   * client), the server forwarding their signals (`qd:peer`) and relaying
   * their messages (`qd:relay`) when no direct path forms. It authorizes
   * both by room membership and never sees what a direct link carries, so a
   * service trusts nothing a peer reports. `qd:hello` then lists `"peer"` in
   * `features` and the relay's limits in `limits.peers`. Default `false`:
   * clients open no links, and the server forwards nothing between them.
   * Host mode (a contract's `serve: "host"` channels and streams) runs over
   * peer links: a server whose services declare any needs `peers: true`.
   */
  readonly peers?: boolean;
}

/**
 * Options of {@link createServer}: the dispatcher's (`services`, `db`,
 * `logger`, `limits`, `onCall` and the pipeline seams) and the server's own.
 * The grants column is `auth.serviceAccessSource` here, which the server
 * gives its dispatcher.
 */
export type ServerOptions<S extends readonly AnyService[]> = DispatcherBaseOptions<S> &
  ServerOnlyOptions<PrincipalOfServices<S>>;

/** Options of `server.rotate`. */
export interface RotateOptions {
  /** Each client reconnects at a random moment within this many milliseconds. */
  readonly withinMs: number;
}

/** A running quickdraw server: what {@link createServer} returns. */
export interface QuickdrawServer<S extends readonly AnyService[] = readonly AnyService[]> {
  /** The Socket.IO server, attached to `httpServer`. */
  readonly io: QuickdrawIo<PrincipalOfServices<S>>;
  /** The HTTP server: the app's, or the one created. Not listening until the app says so. */
  readonly httpServer: HttpServer;
  /**
   * The dispatcher every transport calls; `dispatcher.caller(principal)`
   * calls in process, giving a principal that carries no grants the ones
   * `auth.loadServiceAccess` loads, as a socket's handshake does (once per
   * caller, and again after the server applied new grants). `close()` waits
   * for its calls in flight.
   */
  readonly dispatcher: Dispatcher<S>;
  /**
   * Graceful shutdown: removes the signal handlers, disconnects every socket
   * (cancelling its queries; a mutation runs to its end), waits for the calls
   * still in flight, and closes the HTTP server once its requests finish.
   * After `shutdownTimeoutMs` it stops waiting and closes the remaining
   * connections. Resolves when it is done, so an app can then close its
   * database; calling it again returns the same promise. It never exits the
   * process.
   */
  close(): Promise<void>;
  /**
   * Sends `qd:rotate` to every client: reconnect at a random moment within
   * `withinMs`, for platforms that cap a connection's lifetime.
   */
  rotate(options: RotateOptions): void;
  readonly access: {
    /**
     * Reloads `userId`'s grants with `auth.loadServiceAccess`, puts them in the
     * principal of that user's sockets (on every node: behind a cluster
     * adapter the grants are broadcast), sends them `qd:access`, and resolves
     * the user's entity subscriptions again. Resolves with the grants.
     */
    refresh(userId: string): Promise<ServiceGrants>;
    /**
     * Disconnects every socket of `userId` (only those that authenticated
     * with `sessionId`, when given), on every node: behind a cluster adapter
     * the request is broadcast. For a session the app revoked (wire
     * `createAuthRoutes`' `onRevoke` to it): an open socket keeps the
     * principal it authenticated with, and its reconnect is authenticated
     * afresh. Returns how many sockets this node disconnected.
     */
    disconnectUser(userId: string, options?: DisconnectUserOptions): number;
  };
  /**
   * Who is online, when they were last seen, and who is in a room (RFC 0003
   * section 12.5); the same as `ctx.presence`. Behind a cluster adapter it
   * asks every node.
   */
  readonly presence: Dispatcher<S>["presence"];
  /** The handle of one of the services' streams: `server.stream(task, "logs").push(taskId, line)`. */
  readonly stream: Dispatcher<S>["stream"];
  /**
   * App rooms from code that is not a handler (RFC 0003 section 12.5): typed
   * room events and `leave(room, { userId })`, on every node; the same as
   * `qd.rooms` and the socket-free half of `ctx.rooms`.
   */
  readonly rooms: Dispatcher<S>["rooms"];
}

const DEFAULT_SHUTDOWN_TIMEOUT_MS = 10_000;

/**
 * The startup warnings about `auth`: grants no tracked write refreshes
 * (`warnUnsourcedGrants`), and `socketAuth`'s `devCredentials` while it is
 * on (the 5.1 audit's AUTH-3).
 */
function warnOnAuth(
  services: readonly AnyService[],
  auth: { readonly authenticate?: unknown; readonly serviceAccessSource?: unknown } | undefined,
  logger: Logger,
): void {
  warnUnsourcedGrants(services, auth?.serviceAccessSource !== undefined, logger);
  if (socketAuthOf(auth?.authenticate)?.devCredentials === true) {
    logger.warn(
      "socketAuth's devCredentials is on: a socket handshake that names a user id signs in as that user, from any page; never set it outside development",
      { category: "quickdraw.auth" },
    );
  }
}

function checkOptions<P extends Principal>(options: ServerOnlyOptions<P>): void {
  // Before anything exists, the dispatcher included: options refused here leave nothing attached
  // to the tracked client, and no server, adapter subscription or background check.
  checkKeyPrefix(options.cluster);
  if (options.http !== false) {
    checkHttpTransportOptions(options.http ?? {});
  }
  if (options.app !== undefined && typeof options.app.use !== "function") {
    throw new TypeError("createServer: app must be an Express app");
  }
  if (options.httpServer !== undefined && typeof options.httpServer.listen !== "function") {
    throw new TypeError("createServer: httpServer must be a Node HTTP server");
  }
  // The HTTP transport is mounted on `app`; a server passed without it would
  // build the transport, attach it nowhere, and answer every call with the
  // app's own handler.
  if (options.httpServer !== undefined && options.app === undefined && options.http !== false) {
    throw new TypeError(
      "createServer: httpServer was given without app, so the HTTP transport has nowhere to mount; pass the Express app the server was created from as app, or set http: false to serve sockets only",
    );
  }
  const timeout = options.shutdownTimeoutMs;
  if (timeout !== undefined && !(Number.isSafeInteger(timeout) && timeout >= 0)) {
    throw new TypeError("createServer: shutdownTimeoutMs must be a whole number of milliseconds");
  }
  if (options.peers !== undefined && typeof options.peers !== "boolean") {
    throw new TypeError("createServer: peers must be true or false");
  }
  for (const hook of ["onRoomLeave", "onHostLeave"] as const) {
    if (options[hook] !== undefined && typeof options[hook] !== "function") {
      throw new TypeError(
        `createServer: ${hook} must be a function of the leave and a run context`,
      );
    }
  }
  // Socket.IO turns recovery on for any truthy value, `{}` included.
  const socket = options.socket as Readonly<Record<string, unknown>> | undefined;
  if (socket?.connectionStateRecovery) {
    throw new TypeError(
      "createServer: socket.connectionStateRecovery is refused: Socket.IO's connection state recovery restores a reconnecting socket's principal and rooms without authenticating it again, so a revoked session or a lowered grant would come back. quickdraw clients resume by revision on every reconnect; remove the option",
    );
  }
}

/**
 * Host mode runs over peer links: a service whose contract has a channel or
 * a stream the room's host serves needs a server created with `peers: true`.
 */
function checkHostMode(services: readonly AnyService[], peers: boolean): void {
  for (const service of peers ? [] : services) {
    const { channels, streams } = service.contract;
    const hosted = [
      ...Object.entries(channels).map(([name, def]) => [`channel "${name}"`, def] as const),
      ...Object.entries(streams).map(([name, def]) => [`stream "${name}"`, def] as const),
    ].find(([, def]) => (def as { readonly serve?: unknown }).serve === "host");
    if (hosted !== undefined) {
      throw new TypeError(
        `createServer: ${service.name}'s ${hosted[0]} is served by the room's host (serve: "host"), which runs over peer links; create the server with peers: true`,
      );
    }
  }
}

/**
 * Runs every service's `onRoomLeave` and `onHostLeave` and the server's own
 * for every socket that leaves app rooms and every host that leaves its
 * room, each in a detached unit of work of the dispatcher of its own; what
 * one throws is logged, and the others still run.
 */
function listenForLeaves<P extends Principal>(
  dispatcher: Dispatcher,
  handlers: { readonly room?: RoomLeaveHandler<P>; readonly host?: HostLeaveHandler<P> },
): void {
  const services = [...dispatcher.registry.services.values()];
  const rooms: RoomLeaveHook[] = services.flatMap((service) =>
    service.onRoomLeave === undefined
      ? []
      : [{ owner: service.name, handler: service.onRoomLeave }],
  );
  const hosts: HostLeaveHook[] = services.flatMap((service) =>
    service.onHostLeave === undefined
      ? []
      : [{ owner: service.name, handler: service.onHostLeave }],
  );
  if (handlers.room !== undefined) {
    rooms.push({ owner: "createServer", handler: handlers.room as RoomLeaveHandler });
  }
  if (handlers.host !== undefined) {
    hosts.push({ owner: "createServer", handler: handlers.host as HostLeaveHandler });
  }
  const run = async (fn: Parameters<typeof dispatcher.run>[0]): Promise<void> => {
    await dispatcher.run(fn, { detached: true });
  };
  const realtime = liveOf(dispatcher)?.realtime;
  realtime?.onRoomLeave(rooms, run);
  realtime?.onHostLeave(hosts, run);
}

/**
 * The HTTP transport, or `undefined` with `http: false`. `startServer` mounts
 * it on `app`, when there is one, once the sockets are made.
 */
function routerFor<P extends Principal>(
  options: ServerOnlyOptions<P>,
  base: Omit<Parameters<typeof httpRouterSettings>[1], "cookieAsToken">,
): HttpRouter | undefined {
  if (options.http === false) {
    return undefined;
  }
  // socketAuth's authenticate takes the session cookie as auth.token; any other gets it beside.
  const cookieAsToken = socketAuthOf(options.auth?.authenticate) !== undefined;
  return httpRouter(httpRouterSettings(options.http ?? {}, { ...base, cookieAsToken }));
}

/**
 * The Socket.IO side of the server, on `httpServer`: the dispatcher's live
 * data and, with `peers: true`, its peer links, which hear the other nodes
 * once the server is attached.
 */
function serveSockets<P extends Principal>(
  options: ServerOnlyOptions<P>,
  created: object,
  httpServer: HttpServer,
  base: Pick<SocketServerSettings, "dispatcher" | "logger" | "resolvePrincipal" | "legacyWire">,
): SocketServer {
  const live = liveOf(created);
  const peers = options.peers === true ? live?.peers : undefined;
  const sockets = createSocketServer(httpServer, {
    ...base,
    loadServiceAccess: options.auth?.loadServiceAccess,
    binary: options.binary === true,
    cors: options.cors,
    socket: options.socket,
    rateLimit: options.rateLimit ?? {},
    extensions: peers === undefined ? [] : [peers.extension],
    live,
    loops: loopsOf(created),
    cluster: options.cluster,
    peers: peers !== undefined,
  });
  peers?.listen();
  return sockets;
}

function notFound(_req: IncomingMessage, res: ServerResponse): void {
  res.statusCode = 404;
  res.end();
}

/**
 * Warns, once at startup, when an admin screen edits users' service-wide
 * grants (`admin.handlers(c, { grants: true })`) but `auth.serviceAccessSource`
 * does not say where they are stored: a lowered grant then stays on the
 * user's open sockets until they connect again (the final review of the
 * release candidates).
 */
function warnUnsourcedGrants(
  services: readonly AnyService[],
  sourced: boolean,
  logger: Logger,
): void {
  if (sourced) {
    return;
  }
  const editors = services
    .filter((service) =>
      Object.values(service.methods).some((method) => editsGrants(method.handler)),
    )
    .map((service) => service.name);
  if (editors.length > 0) {
    logger.warn(
      `createServer: ${editors.join(", ")} edit users' service-wide grants (the admin kit's grants: true), but auth.serviceAccessSource does not name where they are stored, so a user whose grant is lowered keeps it on open sockets until they connect again. Set auth.serviceAccessSource: { model, column }`,
      { category: "quickdraw.access", services: editors },
    );
  }
}

/**
 * `options` with what the server adds to its dispatcher: the grants sink
 * right after the access sink (a flush that lowers grants revokes before its
 * frames go out), and `auth.serviceAccessSource`, which the admin kit reads.
 */
function withGrants<O extends object>(
  options: O,
  grants: ReturnType<typeof createGrantsSink>,
  grantsSource: { readonly model: string; readonly column: string } | undefined,
): O & { readonly serviceAccessSource?: { readonly model: string; readonly column: string } } {
  if ((options as { readonly serviceAccessSource?: unknown }).serviceAccessSource !== undefined) {
    throw new TypeError(
      "createServer: name the grants column as auth.serviceAccessSource, which also refreshes the grants it stores; serviceAccessSource is createDispatcher's option",
    );
  }
  return withServerParts(
    { ...options, ...(grantsSource === undefined ? {} : { serviceAccessSource: grantsSource }) },
    { accessSinks: grants === undefined ? [] : [grants] },
  );
}

/**
 * Serves `services` over Socket.IO and HTTP on the app's own Express app and
 * HTTP server: socket authentication, the `user:{id}` room, `qd:hello`, the
 * v5 transport (or the 4.x shim), the HTTP transport at `POST /qd/{service}/{method}`,
 * disconnect cleanup and graceful shutdown. It does not listen: the app calls
 * `server.httpServer.listen(port)`.
 *
 * @example
 * const app = express();
 * app.use(express.json());
 * const server = createServer({ app, services: [taskService], db: prisma, auth: { authenticate } });
 * server.httpServer.listen(4000);
 */
export function createServer<const S extends readonly AnyService[]>(
  options: ServerOptions<S>,
): QuickdrawServer<S> {
  checkOptions(options);
  checkHostMode(options.services, options.peers === true);
  const legacyWire = resolveLegacyWire(options.legacyWire, options.services);
  const logger = options.logger ?? consoleLogger;
  warnOnAuth(options.services, options.auth, logger);
  const watchdog = prepareWatchdog(options, options.stallWatchdog);
  let refresh: ((userId: string) => Promise<ServiceGrants>) | undefined;
  const grants = createGrantsSink(options.auth, () => refresh, logger);
  const created = createDispatcher(
    withGrants(watchdog.options, grants, options.auth?.serviceAccessSource),
  );
  // The dispatcher is attached to the tracked client now (and its access cache, with `cacheMs`,
  // hears the client's writes): a start that throws from here detaches it before the error goes on.
  try {
    const server = startServer(options, created, {
      logger,
      legacyWire,
      startWatchdog: watchdog.start,
    });
    refresh = server.access.refresh;
    return server;
  } catch (error) {
    detachFailedStart(created);
    throw error;
  }
}

/**
 * Detaches the dispatcher of a server that failed to start, as `close()`
 * does once a server stopped: the tracked client goes back to the
 * dispatcher attached before, and the access cache stops hearing its
 * writes. The start's own error is the one `createServer` throws, even when
 * this throws too (the tracker is detached even then: `detachDispatcher`).
 */
function detachFailedStart(created: object): void {
  try {
    detachDispatcher(created);
  } catch {
    // The start's error says what went wrong.
  }
}

/** Serves `created`: the rest of `createServer`, which detaches it again when this throws. */
function startServer<const S extends readonly AnyService[]>(
  options: ServerOptions<S>,
  created: Dispatcher<S>,
  parts: Pick<SocketServerSettings, "logger" | "legacyWire"> & {
    readonly startWatchdog: ServerWatchdog<unknown>["start"];
  },
): QuickdrawServer<S> {
  const { logger, legacyWire } = parts;
  const calls = trackCalls(created);
  const { dispatcher } = calls;
  listenForLeaves(created as Dispatcher, { room: options.onRoomLeave, host: options.onHostLeave });
  // Both transports' `authenticate`, which warns once in development when it throws anything
  // but a QuickdrawError (`authenticate-threw`).
  const resolvePrincipal = createPrincipalResolver(options.auth, logger);
  const router = routerFor(options, { call: dispatcher.call, resolvePrincipal, logger });
  const httpServer = options.httpServer ?? createHttpServer(options.app ?? router ?? notFound);
  // The last part that can fail: Socket.IO checks its options and makes its adapter before it
  // attaches to `httpServer`, so a start that fails here leaves the app's HTTP server as it was.
  const sockets = serveSockets(options, created, httpServer, {
    dispatcher,
    logger,
    resolvePrincipal,
    legacyWire,
  });
  // What cannot be undone waits for the sockets: the router on the app, and the checks in the
  // background (a test app awaits them: `startupChecksOf`).
  if (router !== undefined) {
    options.app?.use(router);
  }
  startStartupChecks(dispatcher, options, logger);
  // In-process callers (`dispatcher.caller`, `qd.caller`) load a principal's grants as the
  // handshake does, and again once this node applied new grants to a user.
  const load = options.auth?.loadServiceAccess;
  if (load !== undefined) {
    calls.loadGrantsWith({ load, version: () => sockets.regrants() });
  }
  const shutdown = closer(
    sockets,
    httpServer,
    () => calls.idle(),
    options.shutdownTimeoutMs ?? DEFAULT_SHUTDOWN_TIMEOUT_MS,
    {
      drain: () => liveOf(created)?.drain() ?? Promise.resolve(),
      timeoutMs: options.cluster?.timeoutMs,
    },
  );
  const { onClose } = shutdown;
  onClose(sockets.stop);
  // Once stopped (its sockets leave first, and what their last events started settles while the
  // adapter still reaches the other nodes: `closer`), and once anything started after that has
  // settled too, the tracked client goes back to the dispatcher attached before.
  let closing: Promise<void> | undefined;
  const close = (): Promise<void> =>
    (closing ??= shutdown.close().then(async () => {
      await liveOf(created)?.drain();
      detachDispatcher(created);
    }));
  if (options.handleSignals === true) {
    onClose(watchSignals(close, logger));
  }
  if (parts.startWatchdog !== undefined) {
    onClose(parts.startWatchdog(logger).stop);
  }
  return Object.freeze({
    io: sockets.io as QuickdrawIo<PrincipalOfServices<S>>,
    httpServer,
    dispatcher,
    close,
    rotate: ({ withinMs }: RotateOptions) => sockets.rotate(withinMs),
    access: Object.freeze({
      refresh: (userId: string) => sockets.refresh(userId),
      disconnectUser: (userId: string, disconnect?: DisconnectUserOptions) =>
        sockets.disconnectUser(userId, disconnect),
    }),
    presence: dispatcher.presence,
    stream: dispatcher.stream,
    rooms: dispatcher.rooms,
  });
}
