// One method call over a client connection (RFC 0003 sections 8.2, 9 and
// 11.2): a `qd:call` envelope with a fresh id, answered through Socket.IO's
// acknowledgement. 4.1 sent one event per method and resolved the
// `{ success, data }` reply (`legacy-src/client/useServiceQuery.ts:94-121`).
//
// - A failed call rejects with the `QuickdrawError` the reply carries.
//   `RATE_LIMITED` also starts the connection's backoff for the call's kind,
//   and while it lasts a call of that kind fails at once, without being
//   sent, so a client that is being limited stops spending the budget.
// - Aborting the signal rejects with `CANCELLED` and sends `qd:cancel`; a
//   call still waiting in Socket.IO's send buffer is dropped instead, so it
//   never reaches the server.
// - No answer within the time limit rejects with `TIMEOUT`. It is never
//   retried here: the server may still be running the call.
// - A connection that drops before the answer, or is not open at all,
//   rejects with `INTERNAL`. A call made while the socket reconnects waits in
//   Socket.IO's send buffer, within its time limit.
// - A reply `{ ok: true, nm: true, v }` resolves as it is: the version the
//   caller sent is current, and the caller keeps its copy.
//
// React-free: the hooks call through here, and so can any other client.

import type { MethodKind } from "../contract/methods";
import { CLIENT_EVENTS } from "../contract/names";
import type {
  CallEnvelope,
  CallId,
  CallNotModified,
  CallSuccess,
  Version,
} from "../protocol/envelope";
import { QuickdrawError, fromWire } from "../protocol/errors";
import { isRecord } from "../protocol/guards";
import { retryAfterOf } from "./backoff";
import { isTimeLimit, type QuickdrawConnection, type QuickdrawSocket } from "./connection";
import { notifyEach } from "./watch";

/** One call, as {@link call} takes it. */
export interface CallRequest {
  /** The service's name on the wire: the contract's `name`. */
  readonly service: string;
  readonly method: string;
  /** The input; left out of the envelope when `undefined`. */
  readonly input?: unknown;
  /** The method's kind, which picks the backoff a `RATE_LIMITED` answer starts. Default `"query"`. */
  readonly kind?: MethodKind;
  /** Aborting it cancels the call. */
  readonly signal?: AbortSignal;
  /** How long to wait for the answer. Default: the connection's `timeoutMs`. */
  readonly timeoutMs?: number;
  /** The version of the result the caller holds; the server answers "not modified" while it is current. */
  readonly v?: Version;
  /**
   * Called with the result the moment the reply arrives, before any frame
   * the server sent after it is handled; the returned promise settles only
   * after more microtasks, and a client on Node can handle several frames in
   * between. What must follow reply order goes here: an optimistic layer
   * ends at the first newer frame after its call's reply.
   */
  readonly onReply?: (result: CallResult) => void;
}

/** What a call resolves with: the data, or "not modified" when the `v` it sent is current. */
export type CallResult<Output = unknown> = CallSuccess<Output> | CallNotModified;

/** True when the server answered that the caller's version is current. */
export function isNotModified(result: CallResult): result is CallNotModified {
  return result.nm === true;
}

/** The error a cancelled call rejects with. */
function cancelledError(): QuickdrawError {
  return new QuickdrawError("CANCELLED", "The call was cancelled");
}

function internalError(message: string): QuickdrawError {
  return new QuickdrawError("INTERNAL", message);
}

/** Why a call fails before it is sent, if it does. */
function refusedBeforeSending(
  connection: QuickdrawConnection,
  kind: MethodKind,
  signal: AbortSignal | undefined,
): QuickdrawError | undefined {
  if (signal?.aborted === true) {
    return cancelledError();
  }
  const { socket } = connection;
  if (!socket.connected && !socket.active) {
    return internalError("Not connected to the server");
  }
  const remaining = connection.backoffRemaining(kind);
  if (remaining > 0) {
    return new QuickdrawError(
      "RATE_LIMITED",
      `Waiting before more ${kind} calls: the server answered RATE_LIMITED`,
      { retryAfterMs: Math.ceil(remaining) },
    );
  }
  return undefined;
}

function envelopeOf(id: CallId, request: CallRequest): CallEnvelope {
  return {
    id,
    s: request.service,
    m: request.method,
    ...(request.input === undefined ? {} : { i: request.input }),
    ...(request.v === undefined ? {} : { v: request.v }),
  };
}

/** The result or error a reply stands for; `RATE_LIMITED` starts the kind's backoff. */
function readReply(
  connection: QuickdrawConnection,
  kind: MethodKind,
  reply: unknown,
): CallResult | QuickdrawError {
  if (isRecord(reply) && reply.ok === true) {
    const versioned = typeof reply.v === "string" || typeof reply.v === "number";
    if (reply.nm === true && !versioned) {
      return internalError("The server answered not modified without a version");
    }
    return reply as unknown as CallResult;
  }
  if (isRecord(reply) && reply.ok === false) {
    const error = fromWire(reply.e);
    if (error.code === "RATE_LIMITED") {
      connection.reportRateLimited(kind, retryAfterOf(error));
    }
    return error;
  }
  return internalError("The server's reply is not a call reply");
}

/** True when a send-buffer packet is the `qd:call` frame of call `id`. */
function isQueuedCall(data: unknown, id: CallId): boolean {
  return (
    Array.isArray(data) && data[0] === CLIENT_EVENTS.call && isRecord(data[1]) && data[1].id === id
  );
}

/** Drops the call from Socket.IO's send buffer, or else asks the server to cancel it. */
function cancelCall(socket: QuickdrawSocket, id: CallId): void {
  const queued = socket.sendBuffer.findIndex((packet) => isQueuedCall(packet.data, id));
  if (queued >= 0) {
    socket.sendBuffer.splice(queued, 1);
  } else if (socket.connected) {
    socket.emit(CLIENT_EVENTS.cancel, { id });
  }
}

/**
 * Calls `request.method` of `request.service` over `connection`. Resolves
 * with `{ ok: true, d, v? }`, or `{ ok: true, nm: true, v }` when the `v` it
 * sent is current; rejects with a `QuickdrawError` (see the top of this file
 * for which code when).
 *
 * @example
 * const reply = await call(connection, { service: "taskService", method: "get", input: { id } });
 * const task = isNotModified(reply) ? cached : reply.d;
 */
export function call<Output = unknown>(
  connection: QuickdrawConnection,
  request: CallRequest,
): Promise<CallResult<Output>> {
  const kind = request.kind ?? "query";
  const { signal } = request;
  const refused = refusedBeforeSending(connection, kind, signal);
  if (refused !== undefined) {
    return Promise.reject(refused);
  }
  const { socket } = connection;
  const timeoutMs = request.timeoutMs ?? connection.timeoutMs;
  if (!isTimeLimit(timeoutMs)) {
    return Promise.reject(
      new TypeError(
        "call: timeoutMs must be a number of milliseconds, above 0 and at most 2^31 - 1",
      ),
    );
  }
  const id = connection.nextCallId();
  return new Promise<CallResult<Output>>((resolve, reject) => {
    let settled = false;
    const settle = (outcome: CallResult | QuickdrawError): void => {
      if (settled) {
        return;
      }
      settled = true;
      signal?.removeEventListener("abort", onAbort);
      if (outcome instanceof QuickdrawError) {
        reject(outcome);
      } else {
        notifyEach([request.onReply], (onReply) => {
          onReply?.(outcome);
        });
        resolve(outcome as CallResult<Output>);
      }
    };
    function onAbort(): void {
      cancelCall(socket, id);
      settle(cancelledError());
    }
    socket
      .timeout(timeoutMs)
      .emit(CLIENT_EVENTS.call, envelopeOf(id, request), (error: Error | null, reply: unknown) => {
        if (error === null) {
          settle(readReply(connection, kind, reply));
        } else if (socket.connected) {
          settle(new QuickdrawError("TIMEOUT", `No answer within ${timeoutMs} ms`));
        } else {
          settle(internalError("No answer: the connection to the server is down"));
        }
      });
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

/**
 * Calls a method and resolves with its data. For a caller that sends no
 * version, which is never answered "not modified".
 */
export async function callData<Output = unknown>(
  connection: QuickdrawConnection,
  request: Omit<CallRequest, "v">,
): Promise<Output> {
  const result = await call<Output>(connection, request);
  if (isNotModified(result)) {
    throw internalError("The server answered not modified to a call that sent no version");
  }
  return result.d;
}

/**
 * The default `retry` of query hooks: one more attempt after an `INTERNAL`
 * error, which includes a dropped connection, or an error that is not a
 * `QuickdrawError`; none for any other code. A `TIMEOUT` is not retried,
 * because the server may still be running the call, and `RATE_LIMITED`
 * waits for the backoff instead.
 */
export function shouldRetry(failureCount: number, error: unknown): boolean {
  return failureCount < 1 && (!(error instanceof QuickdrawError) || error.code === "INTERNAL");
}
