// The Socket.IO server of a quickdraw server: the parser, the protocol and
// authentication middlewares, the rate limiter and the connection handler,
// plus the two pushes a server sends on the app's request, `qd:rotate` and
// `qd:access`.

import type { Server as HttpServer } from "node:http";
import { Server, type ServerOptions } from "socket.io";
import { SERVER_EVENTS, userRoom } from "../../contract/names";
import { PROTOCOL_VERSION, type HelloFrame } from "../../protocol/version";
import { QUICKDRAW_VERSION } from "../../version";
import { createReplyMeter } from "./ack";
import type { ResolvePrincipal, ServerAuth, ServiceGrants } from "./auth";
import {
  applySocketRateLimit,
  authMiddleware,
  protocolMiddleware,
  type SocketRateLimitOptions,
} from "./middleware";
import { onConnection, type SocketExtension } from "./socketio";
import type { QuickdrawIo, SocketContext } from "./types";

export type { SocketRateLimitOptions } from "./middleware";

/** Socket.IO server options `createServer` passes through; it sets `parser` and `cors` itself. */
export type SocketOptions = Partial<Omit<ServerOptions, "parser" | "cors">>;

/** Socket.IO's CORS setting for the handshake and polling requests. */
export type SocketCors = Partial<ServerOptions>["cors"];

/** Ids one `qd:sub` may name (RFC 0003 section 6), announced in `qd:hello`. */
export const DEFAULT_MAX_SUBSCRIBE_IDS = 500;

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
}

/** The Socket.IO side of a quickdraw server. */
export interface SocketServer {
  readonly io: QuickdrawIo;
  /** Tells every client to reconnect at a random moment within `withinMs`. */
  rotate(withinMs: number): void;
  /** Reloads `userId`'s service grants into their sockets' principals and sends them `qd:access`. */
  refresh(userId: string): Promise<ServiceGrants>;
}

function helloFrame(settings: SocketServerSettings): HelloFrame {
  const { limits } = settings.dispatcher;
  return Object.freeze({
    protocol: PROTOCOL_VERSION,
    server: QUICKDRAW_VERSION,
    limits: Object.freeze({
      maxInFlightQueries: limits.maxInFlightQueries,
      maxQueuedQueries: limits.maxQueuedQueries,
      maxSubscribeIds: DEFAULT_MAX_SUBSCRIBE_IDS,
      callTimeoutMs: limits.callTimeoutMs,
    }),
    features: Object.freeze(settings.binary ? ["binary"] : []),
  });
}

function rotate(io: QuickdrawIo, withinMs: number): void {
  if (typeof withinMs !== "number" || !Number.isFinite(withinMs) || withinMs < 0) {
    throw new TypeError("rotate: withinMs must be a number of milliseconds, 0 or more");
  }
  io.emit(SERVER_EVENTS.rotate, { withinMs });
}

async function refresh(
  io: QuickdrawIo,
  load: ServerAuth["loadServiceAccess"],
  userId: string,
): Promise<ServiceGrants> {
  if (load === undefined) {
    throw new TypeError("access.refresh needs auth.loadServiceAccess to reload a user's grants");
  }
  const serviceAccess = (await load(userId)) ?? {};
  const room = userRoom(userId);
  // The sockets of this process; a multi-node app refreshes on every node.
  for (const socketId of io.sockets.adapter.rooms.get(room) ?? []) {
    const socket = io.sockets.sockets.get(socketId);
    const principal = socket?.data.principal;
    if (socket !== undefined && principal?.userId === userId) {
      socket.data.principal = { ...principal, serviceAccess };
    }
  }
  io.to(room).emit(SERVER_EVENTS.access, { serviceAccess });
  return serviceAccess;
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
  io.use(protocolMiddleware(settings.legacyWire, context));
  io.use(authMiddleware(settings.resolvePrincipal, context));
  // Before the connection handler: the limiter's `socket.use` middleware must
  // come before the legacy shim's, so it counts each 4.x call before it runs.
  if (settings.rateLimit !== false) {
    applySocketRateLimit(io, settings.rateLimit, context);
  }
  io.on(
    "connection",
    onConnection({
      ...context,
      hello: helloFrame(settings),
      extensions: settings.extensions,
      legacyCallers: new Set(),
    }),
  );
  return {
    io,
    rotate: (withinMs) => rotate(io, withinMs),
    refresh: (userId) => refresh(io, settings.loadServiceAccess, userId),
  };
}
