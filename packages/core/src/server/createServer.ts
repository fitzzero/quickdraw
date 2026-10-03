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
import { consoleLogger, type Logger } from "../contract/logger";
import { createCaller, type Caller } from "./caller";
import {
  createDispatcher,
  type ContractOfServices,
  type Dispatcher,
  type DispatcherOptions,
  type PrincipalOfServices,
} from "./dispatcher";
import { liveOf } from "./emit/live";
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
  type QuickdrawIo,
  type SocketCors,
  type SocketOptions,
  type SocketRateLimitOptions,
  type SocketServer,
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
   * none. Default: 100 events per minute per socket. `qd:ch`, `qd:cancel`,
   * `qd:sub` and `qd:unsub` are never counted.
   */
  readonly rateLimit?: SocketRateLimitOptions | false;
  /** The HTTP transport's options, or `false` to serve no HTTP calls. */
  readonly http?: HttpTransportOptions | false;
  /** Close the server on `SIGTERM` and `SIGINT`. Default `false`. The process is never exited. */
  readonly handleSignals?: boolean;
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
  };
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

/** The app's own flush sinks, as a list. */
function sinksOf(options: { readonly flushSink?: DispatcherOptions<[]>["flushSink"] }) {
  const { flushSink } = options;
  if (flushSink === undefined) {
    return [];
  }
  return Array.isArray(flushSink) ? flushSink : [flushSink];
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

/** Watches `SIGTERM` and `SIGINT` until the server closes; returns the function that stops watching. */
function watchSignals(close: () => Promise<void>, logger: Logger): () => void {
  const onSignal = (signal: NodeJS.Signals): void => {
    logger.info(`Received ${signal}; closing the quickdraw server`, {
      category: "quickdraw.server",
    });
    close().catch((error: unknown) => {
      logger.error("Closing the quickdraw server failed", {
        category: "quickdraw.server",
        error: error instanceof Error ? error.message : String(error),
      });
    });
  };
  process.once("SIGTERM", onSignal);
  process.once("SIGINT", onSignal);
  return () => {
    process.off("SIGTERM", onSignal);
    process.off("SIGINT", onSignal);
  };
}

/** A dispatcher whose calls in flight can be awaited. */
interface TrackedDispatcher<S extends readonly AnyService[]> {
  readonly dispatcher: Dispatcher<S>;
  /** Resolves once no call is in flight. */
  idle(): Promise<void>;
}

/**
 * Counts the calls in flight through `dispatcher`, the transports' and the
 * in-process caller's alike, so `close()` can wait for them.
 */
function trackCalls<S extends readonly AnyService[]>(
  dispatcher: Dispatcher<S>,
): TrackedDispatcher<S> {
  const running = new Set<Promise<unknown>>();
  const call: Dispatcher<S>["call"] = (request) => {
    const result = dispatcher.call(request);
    running.add(result);
    const done = (): void => {
      running.delete(result);
    };
    void result.then(done, done);
    return result;
  };
  return {
    dispatcher: Object.freeze({
      ...dispatcher,
      call,
      caller: (principal: PrincipalOfServices<S> | null) =>
        createCaller(() => call, principal) as Caller<ContractOfServices<S>>,
    }),
    async idle() {
      while (running.size > 0) {
        await Promise.allSettled([...running]);
      }
    },
  };
}

/** The server's `close`: one shutdown, however often it is called. */
function closer(
  sockets: SocketServer,
  httpServer: HttpServer,
  idle: () => Promise<void>,
  timeoutMs: number,
): { close: () => Promise<void>; onClose: (stop: () => void) => void } {
  let closing: Promise<void> | undefined;
  let stop = (): void => undefined;
  const shutdown = async (): Promise<void> => {
    stop();
    let expire = (): void => undefined;
    const expired = new Promise<void>((resolve) => {
      expire = resolve;
    });
    const timer = setTimeout(() => {
      httpServer.closeAllConnections();
      expire();
    }, timeoutMs);
    try {
      // Disconnects every socket and closes `httpServer` once its requests
      // end, while the calls still running finish: a mutation runs to its end.
      await Promise.all([sockets.io.close(), Promise.race([idle(), expired])]);
    } finally {
      clearTimeout(timer);
    }
  };
  return {
    close: () => (closing ??= shutdown()),
    onClose: (callback) => {
      stop = callback;
    },
  };
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
  let refresh: ((userId: string) => Promise<ServiceGrants>) | undefined;
  const grants = createGrantsSink(options.auth, () => refresh, logger);
  const created = createDispatcher(
    grants === undefined ? options : { ...options, flushSink: [...sinksOf(options), grants] },
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
  const { close, onClose } = closer(
    sockets,
    httpServer,
    () => calls.idle(),
    options.shutdownTimeoutMs ?? DEFAULT_SHUTDOWN_TIMEOUT_MS,
  );
  if (options.handleSignals === true) {
    onClose(watchSignals(close, logger));
  }
  return Object.freeze({
    io: sockets.io as QuickdrawIo<PrincipalOfServices<S>>,
    httpServer,
    dispatcher,
    close,
    rotate: ({ withinMs }: RotateOptions) => sockets.rotate(withinMs),
    access: Object.freeze({ refresh: (userId: string) => sockets.refresh(userId) }),
  });
}
