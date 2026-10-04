// The Socket.IO server of a quickdraw server: the parser, the protocol and
// authentication middlewares, the rate limiter and the connection handler,
// the dispatcher's live data (entity subscriptions), plus the two pushes a
// server sends on the app's request, `qd:rotate` and `qd:access`.

import type { Server as HttpServer } from "node:http";
import { Server, type ServerOptions } from "socket.io";
import { MAX_SUBSCRIBE_IDS, PROTOCOL_VERSION } from "../../protocol/version";
import { QUICKDRAW_VERSION } from "../../version";
import { createReplyMeter } from "./ack";
import type { ResolvePrincipal, ServerAuth, ServiceGrants } from "./auth";
import {
  applySocketRateLimit,
  authMiddleware,
  protocolMiddleware,
  type SocketLimitContext,
  type SocketRateLimitOptions,
} from "./middleware";
import {
  adapterProbe,
  disconnectUser,
  listenForDisconnects,
  listenForGrants,
  refreshGrants,
  rotate,
  serveBroadcasts,
  type ClusterOptions,
  type DisconnectUserOptions,
  type LiveData,
} from "./pushes";
import { onConnection, type ServerHello, type SocketExtension } from "./socketio";
import type { QuickdrawIo, SocketContext } from "./types";

export type { SocketRateLimitOptions } from "./middleware";
export type { ClusterOptions, DisconnectUserOptions } from "./pushes";
export type { QuickdrawIo } from "./types";

/** Socket.IO server options `createServer` passes through; it sets `parser` and `cors` itself. */
export type SocketOptions = Partial<Omit<ServerOptions, "parser" | "cors">>;

/** Socket.IO's CORS setting for the handshake and polling requests. */
export type SocketCors = Partial<ServerOptions>["cors"];

/** Settings of {@link createSocketServer}. */
export interface SocketServerSettings extends Omit<SocketContext, "meter"> {
  readonly resolvePrincipal: ResolvePrincipal;
  readonly loadServiceAccess: ServerAuth["loadServiceAccess"];
  readonly binary: boolean;
  readonly legacyWire: boolean;
  readonly cors: SocketCors;
  readonly socket: SocketOptions | undefined;
  readonly rateLimit: SocketRateLimitOptions | false;
  readonly extensions: readonly SocketExtension[];
  /** The dispatcher's live data: its extension serves `qd:sub`, and it is given the server. */
  readonly live?: LiveData;
  /** Where a cluster's shared state lives, behind a cluster adapter (`createServer`'s `cluster`). */
  readonly cluster?: ClusterOptions;
  /** The dispatcher's loop watch, which counts the rate limiter's refusals too. */
  readonly loops?: SocketLimitContext["loops"];
}

/** The Socket.IO side of a quickdraw server. */
export interface SocketServer {
  readonly io: QuickdrawIo;
  /** Tells every client to reconnect at a random moment within `withinMs`. */
  rotate(withinMs: number): void;
  /** Reloads `userId`'s service grants into their sockets' principals and sends them `qd:access`. */
  refresh(userId: string): Promise<ServiceGrants>;
  /** Disconnects `userId`'s sockets (of one session) on every node; returns how many this node ended. */
  disconnectUser(userId: string, options?: DisconnectUserOptions): number;
  /** Stops what runs in the background (a degraded node's probes): the server closes. */
  stop(): void;
}

/** The part of `qd:hello` every socket of the server shares; `onConnection` adds the principal's. */
function helloFrame(settings: SocketServerSettings): ServerHello {
  const { limits } = settings.dispatcher;
  return Object.freeze({
    protocol: PROTOCOL_VERSION,
    server: QUICKDRAW_VERSION,
    limits: Object.freeze({
      maxInFlightQueries: limits.maxInFlightQueries,
      maxQueuedQueries: limits.maxQueuedQueries,
      maxSubscribeIds: MAX_SUBSCRIBE_IDS,
      callTimeoutMs: limits.callTimeoutMs,
      subscriptions: Object.freeze({
        maxInFlight: limits.subscriptions.maxInFlight,
        maxQueued: limits.subscriptions.maxQueued,
      }),
    }),
    features: Object.freeze(settings.binary ? ["binary"] : []),
  });
}

/** Attaches a Socket.IO server to `httpServer` and serves the dispatcher over it. */
export function createSocketServer(
  httpServer: HttpServer,
  settings: SocketServerSettings,
): SocketServer {
  const meter = createReplyMeter(settings.binary);
  const io: QuickdrawIo = new Server(httpServer, {
    ...settings.socket,
    ...(settings.cors === undefined ? {} : { cors: settings.cors }),
    ...(meter.parser === undefined ? {} : { parser: meter.parser }),
  });
  const context: SocketContext = {
    dispatcher: settings.dispatcher,
    logger: settings.logger,
    meter,
  };
  const probe = adapterProbe(io, settings.socket?.adapter !== undefined);
  const broadcasts = serveBroadcasts(io, settings.logger, settings.cluster);
  settings.live?.attach(io, probe, settings.cluster, broadcasts);
  listenForGrants(io, settings.live, settings.logger);
  listenForDisconnects(io);
  io.use(protocolMiddleware(settings.legacyWire, context));
  io.use(authMiddleware(settings.resolvePrincipal, context));
  // Before the connection handler: the limiter's `socket.use` middleware must
  // come before the legacy shim's, so it counts each 4.x call before it runs.
  if (settings.rateLimit !== false) {
    applySocketRateLimit(io, settings.rateLimit, { ...context, loops: settings.loops });
  }
  io.on(
    "connection",
    onConnection({
      ...context,
      hello: helloFrame(settings),
      extensions:
        settings.live === undefined
          ? settings.extensions
          : [...settings.extensions, settings.live.extension],
      legacyCallers: new Set(),
    }),
  );
  return {
    io,
    rotate: (withinMs) => rotate(io, withinMs),
    refresh: (userId) =>
      refreshGrants(
        {
          io,
          load: settings.loadServiceAccess,
          live: settings.live,
          probe,
          broadcasts,
        },
        userId,
      ),
    disconnectUser: (userId, options) =>
      disconnectUser(io, probe, settings.logger, userId, options),
    stop: () => {
      broadcasts.close();
    },
  };
}
