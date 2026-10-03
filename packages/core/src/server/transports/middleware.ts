// What every socket passes before `connection` (RFC 0003 section 8.1): the
// protocol check, then authentication. And the socket rate limiter carried
// over from 4.1 (`../rateLimit.ts`), which answers each socket in its own
// protocol's reply shape.

import type { ExtendedError } from "socket.io";
import { CLIENT_EVENTS } from "../../contract/names";
import type { Failure } from "../../protocol/envelope";
import {
  PROTOCOL_MISMATCH,
  PROTOCOL_VERSION,
  isQdHandshake,
  type AuthenticationRefused,
  type ProtocolMismatch,
} from "../../protocol/version";
import { describeError } from "../pipeline/metrics";
import {
  applyRateLimitMiddleware,
  createRateLimiter,
  type RateLimiter,
  type RateLimitOptions,
} from "../rateLimit";
import type { ResolvePrincipal } from "./auth";
import { legacyFailure } from "./legacy";
import type { QuickdrawIo, QuickdrawServerSocket, SocketContext } from "./types";

type Next = (error?: ExtendedError) => void;

/** A refused handshake: Socket.IO sends `message` and `data` as the client's `connect_error`. */
function refusal(message: string, data: ProtocolMismatch | AuthenticationRefused): ExtendedError {
  const error: ExtendedError = new Error(message);
  error.data = data;
  return error;
}

const MISMATCH: ProtocolMismatch = Object.freeze({
  code: PROTOCOL_MISMATCH,
  expected: PROTOCOL_VERSION,
});

const UNAUTHENTICATED: AuthenticationRefused = Object.freeze({ code: "UNAUTHENTICATED" });

/**
 * Reads the handshake's `auth.qd`. Protocol 5 is served. A client without
 * `auth.qd` is a 4.x client: the legacy shim serves it when `legacyWire` is
 * on, and otherwise it is refused, like a client that names another protocol
 * or sends a malformed `qd`, with `{ code: "PROTOCOL_MISMATCH", expected: 5 }`
 * as the `connect_error` data.
 */
export function protocolMiddleware(
  legacyWire: boolean,
  context: Pick<SocketContext, "logger">,
): (socket: QuickdrawServerSocket, next: Next) => void {
  return (socket, next) => {
    const auth: unknown = socket.handshake.auth;
    const qd =
      typeof auth === "object" && auth !== null ? (auth as { qd?: unknown }).qd : undefined;
    if (isQdHandshake(qd) && qd.protocol === PROTOCOL_VERSION) {
      socket.data.protocol = PROTOCOL_VERSION;
      socket.data.client = qd.client;
      next();
      return;
    }
    if (qd === undefined && legacyWire) {
      socket.data.protocol = "legacy";
      next();
      return;
    }
    const spoke = qd === undefined ? "a 4.x client (no auth.qd)" : "another protocol";
    context.logger.debug(`Refused a socket that speaks ${spoke}`, {
      category: "quickdraw.socket",
      socketId: socket.id,
    });
    next(refusal(`This server speaks quickdraw protocol ${PROTOCOL_VERSION}`, MISMATCH));
  };
}

/**
 * Authenticates the socket and keeps its principal on `socket.data`. A
 * failure refuses the connection with "Authentication failed", as 4.1 did,
 * and `{ code: "UNAUTHENTICATED" }` as the `connect_error` data, so a client
 * can tell it from a protocol mismatch.
 */
export function authMiddleware(
  resolvePrincipal: ResolvePrincipal,
  context: Pick<SocketContext, "logger">,
): (socket: QuickdrawServerSocket, next: Next) => void {
  return (socket, next) => {
    const request = {
      transport: "socket",
      auth: socket.handshake.auth as Readonly<Record<string, unknown>>,
      headers: socket.handshake.headers,
      socket,
    } as const;
    resolvePrincipal(request).then(
      (principal) => {
        socket.data.principal = principal;
        next();
      },
      (error: unknown) => {
        context.logger.error("Socket authentication failed", {
          category: "quickdraw.socket",
          socketId: socket.id,
          error: describeError(error),
        });
        next(refusal("Authentication failed", UNAUTHENTICATED));
      },
    );
  };
}

/** The socket rate limiter's options, as `createServer` takes them. */
export type SocketRateLimitOptions = Omit<RateLimitOptions, "logger" | "ackPayload">;

/**
 * Events the limiter never counts: channel messages, which carry their own
 * per-socket token buckets; cancellations, since dropping one only keeps a
 * call running; entity subscriptions, which a page sends once per row it
 * mounts in batches of up to 500 ids, so a board of sixty rows would trip the
 * limiter; collection subscriptions, which a page sends once per list it
 * mounts and again to page through it, and item loads, which a board holding
 * a scope's index sends per window of up to 200 ids; topic watches, which a
 * page sends once per watching query it mounts; and stream subscriptions,
 * which a page sends once per feed it shows (RFC 0003 section 3). The ones
 * that read or authorize (`qd:sub`, `qd:col:sub`, `qd:col:items`,
 * `qd:watch`, `qd:stream:sub`) run in each socket's lane of subscription
 * work instead (`emit/lane.ts`, `limits.subscriptions`).
 */
const UNLIMITED_EVENTS: readonly string[] = [
  CLIENT_EVENTS.channel,
  CLIENT_EVENTS.cancel,
  CLIENT_EVENTS.sub,
  CLIENT_EVENTS.unsub,
  CLIENT_EVENTS.collectionSub,
  CLIENT_EVENTS.collectionUnsub,
  CLIENT_EVENTS.collectionItems,
  CLIENT_EVENTS.watch,
  CLIENT_EVENTS.unwatch,
  CLIENT_EVENTS.streamSub,
  CLIENT_EVENTS.streamUnsub,
];

function rateLimited(retryAfterMs: number): Failure {
  return {
    ok: false,
    e: { code: "RATE_LIMITED", message: "Rate limit exceeded", data: { retryAfterMs } },
  };
}

function isLegacy(socket: { readonly data: unknown }): boolean {
  return (socket.data as Partial<QuickdrawServerSocket["data"]>).protocol === "legacy";
}

/** 4.1's default notice, which 4.x clients listen for; v5 clients read the acknowledgement instead. */
function noticeForLegacyClients(
  limiter: RateLimiter,
  options: SocketRateLimitOptions,
): NonNullable<RateLimitOptions["onRateLimitExceeded"]> {
  const keyOf = options.keyGenerator ?? ((socket) => socket.id);
  return (socket, eventName) => {
    if (isLegacy(socket)) {
      socket.emit("error", {
        code: "RATE_LIMITED",
        message: `Rate limit exceeded for event: ${eventName}`,
        retryAfter: limiter.getResetTime(keyOf(socket, eventName)),
      });
    }
  };
}

/** Applies the socket rate limiter, answering a dropped call in its client's reply shape. */
export function applySocketRateLimit(
  io: QuickdrawIo,
  options: SocketRateLimitOptions,
  context: Pick<SocketContext, "logger">,
): void {
  const limiter = createRateLimiter({
    ...options,
    excludeEvents: [...UNLIMITED_EVENTS, ...(options.excludeEvents ?? [])],
  });
  applyRateLimitMiddleware(io, limiter, {
    logger: context.logger,
    keyGenerator: options.keyGenerator,
    onRateLimitExceeded: options.onRateLimitExceeded ?? noticeForLegacyClients(limiter, options),
    ackPayload: (socket, _eventName, retryAfterMs) =>
      isLegacy(socket)
        ? legacyFailure("RATE_LIMITED", "Rate limit exceeded")
        : rateLimited(retryAfterMs),
  });
}
