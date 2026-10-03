// `createServer` (RFC 0003 sections 3, 8 and 10): serves a dispatcher over
// Socket.IO and HTTP, on the Express app and HTTP server the app already
// owns. It replaces 4.1's `createQuickdrawServer`, which built its own
// Express app and listened itself (`legacy-src/server/createServer.ts:57-67`),
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
import { consoleLogger } from "../contract/logger";
import {
  createDispatcher,
  detachDispatcher,
  withAccessSinks,
  type Dispatcher,
  type DispatcherOptions,
  type PrincipalOfServices,
} from "./dispatcher";
import { liveOf } from "./emit/live";
import {
  closer,
  prepareWatchdog,
  trackCalls,
  watchSignals,
  type StallWatchdogOptions,
} from "./lifecycle";
import type { AnyService } from "./service";
import {
  createGrantsSink,
  createPrincipalResolver,
  type ServerAuth,
  type ServiceGrants,
} from "./transports/auth";
import {
  httpRouter,
  httpRouterSettings,
  type HttpRouter,
  type HttpTransportOptions,
} from "./transports/http";
import {
  createSocketServer,
  type DisconnectUserOptions,
  type QuickdrawIo,
  type SocketCors,
  type SocketOptions,
  type SocketRateLimitOptions,
} from "./transports/socketServer";
import type { Principal } from "./types";

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
  /** Other Socket.IO server options, such as `path` or `pingInterval`. */
  readonly socket?: SocketOptions;
  /**
   * Use the stock Socket.IO parser, so events may carry binary. Default
   * `false`: the JSON-only parser, which also measures each reply's size.
   */
  readonly binary?: boolean;
  /**
   * Serve 4.x clients, which connect without `auth.qd`, through the legacy
   * shim: request/response calls only. Default `false`: they are refused with
   * `PROTOCOL_MISMATCH`.
   */
  readonly legacyWire?: boolean;
  /**
   * The socket rate limiter (`createRateLimiter`'s options), or `false` for
   * none. Default: 100 events per minute per socket. `qd:ch` (channels keep
   * their own per-socket token buckets), `qd:cancel`, the entity and
   * collection subscription events (`qd:sub`, `qd:unsub`, `qd:col:sub`,
   * `qd:col:unsub`, `qd:col:items`), the topic watches (`qd:watch`,
   * `qd:unwatch`) and the stream subscriptions (`qd:stream:sub`,
   * `qd:stream:unsub`) are never counted; the ones that read run in a
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
   * methods when the 99th percentile delay is above `thresholdMs` (200 ms).
   * `true` for the defaults. Default `false`. Stops on `close()`.
   */
  readonly stallWatchdog?: boolean | StallWatchdogOptions;
  /**
   * How long `close()` waits for calls and HTTP requests in flight before it
   * stops waiting and closes their connections, in milliseconds. Default
   * 10,000.
   */
  readonly shutdownTimeoutMs?: number;
}

/**
 * Options of {@link createServer}: the dispatcher's (`services`, `db`,
 * `logger`, `limits`, `onCall` and the pipeline seams) and the server's own.
 */
export type ServerOptions<S extends readonly AnyService[]> = DispatcherOptions<S> &
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
   * calls in process. `close()` waits for its calls in flight.
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
}

const DEFAULT_SHUTDOWN_TIMEOUT_MS = 10_000;

function checkOptions<P extends Principal>(options: ServerOnlyOptions<P>): void {
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
}

/** The HTTP transport, mounted on `app` when there is one. */
function mountRouter<P extends Principal>(
  options: ServerOnlyOptions<P>,
  base: Parameters<typeof httpRouterSettings>[1],
): HttpRouter | undefined {
  if (options.http === false) {
    return undefined;
  }
  const router = httpRouter(httpRouterSettings(options.http ?? {}, base));
  options.app?.use(router);
  return router;
}

function notFound(_req: IncomingMessage, res: ServerResponse): void {
  res.statusCode = 404;
  res.end();
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
  const logger = options.logger ?? consoleLogger;
  const watchdog = prepareWatchdog(options, options.stallWatchdog);
  let refresh: ((userId: string) => Promise<ServiceGrants>) | undefined;
  const grants = createGrantsSink(options.auth, () => refresh, logger);
  // Right after the access sink: a flush that lowers grants revokes before its frames go out.
  const created = createDispatcher(
    grants === undefined ? watchdog.options : withAccessSinks(watchdog.options, [grants]),
  );
  const calls = trackCalls(created);
  const { dispatcher } = calls;
  const resolvePrincipal = createPrincipalResolver(options.auth);
  const router = mountRouter(options, { call: dispatcher.call, resolvePrincipal, logger });
  const httpServer = options.httpServer ?? createHttpServer(options.app ?? router ?? notFound);
  const sockets = createSocketServer(httpServer, {
    dispatcher,
    logger,
    resolvePrincipal,
    loadServiceAccess: options.auth?.loadServiceAccess,
    binary: options.binary === true,
    legacyWire: options.legacyWire === true,
    cors: options.cors,
    socket: options.socket,
    rateLimit: options.rateLimit ?? {},
    extensions: [],
    live: liveOf(created),
  });
  refresh = (userId) => sockets.refresh(userId);
  const shutdown = closer(
    sockets,
    httpServer,
    () => calls.idle(),
    options.shutdownTimeoutMs ?? DEFAULT_SHUTDOWN_TIMEOUT_MS,
  );
  const { onClose } = shutdown;
  // Once stopped, the tracked client goes back to the dispatcher attached before.
  let closing: Promise<void> | undefined;
  const close = (): Promise<void> =>
    (closing ??= shutdown.close().then(() => {
      detachDispatcher(created);
    }));
  if (options.handleSignals === true) {
    onClose(watchSignals(close, logger));
  }
  if (watchdog.start !== undefined) {
    onClose(watchdog.start(logger).stop);
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
  });
}
