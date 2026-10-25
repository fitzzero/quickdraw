// One method call over a client connection (RFC 0003 sections 8.2, 9 and
// 11.2): a `qd:call` envelope with a fresh id, answered through Socket.IO's
// acknowledgement. 4.1 sent one event per method and resolved the
// `{ success, data }` reply (4.1 `src/client/useServiceQuery.ts:94-121`).
//
// - A failed call rejects with the `QuickdrawError` the reply carries.
//   `RATE_LIMITED` also starts the connection's backoff for the call's kind,
//   and while it lasts a call of that kind fails at once, without being
//   sent, so a client that is being limited stops spending the budget.
// - Aborting the signal rejects with `CANCELLED` and sends `qd:cancel`; a
//   call still held for its socket's hello (below) is dropped instead, so it
//   never reaches the server.
// - No answer within the time limit rejects with `TIMEOUT`. It is never
//   retried here: the server may still be running the call.
// - A call is bound, as it is made, to the user it is made as (`issuer.ts`),
//   and goes out only on a confirmed socket: connected, and its own
//   `qd:hello` arrived. One made before then (the first connect, a reconnect
//   after a drop, the connection waiting to connect again after the server
//   could not authenticate it, `mayConnect`) is held by the connection
//   (`callHoldOf`), within its time limit, never in Socket.IO's send buffer,
//   which the next connect would send before that hello, as whoever the
//   socket then speaks for (a session cookie may name someone else). The
//   hello sends it if it names the call's user, by #154's rules, and
//   refuses it `CANCELLED` otherwise; new credentials, `close` and a session
//   refused fail it `CANCELLED` meanwhile (`connection.ts`), and its time
//   running out fails it `INTERNAL`, unsent. Reads are held like writes: a
//   `.call()` read would hand the next user's answer to the last user's code.
//   A call made while the socket still reads connected but its engine is
//   gone (the server's ping overdue: a throttled timer, a device asleep),
//   which Socket.IO keeps in that buffer, is taken back out of it and held
//   the same way, so a reconnect sends it only after its hello.
// - A connection that drops before the answer, or is not open at all,
//   rejects with `INTERNAL`.
// - A `TIMEOUT`, and the `INTERNAL` of a call whose connection dropped after
//   it was sent, leave its outcome unknown: the server may have run it, and
//   may still be running it. `isUnknownOutcome` tells them from refusals, so
//   an optimistic addition waits for its scope's next load instead of being
//   refused (`optimisticCall.ts`).
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
import {
  callHoldOf,
  isTimeLimit,
  mayConnect,
  type QuickdrawConnection,
  type QuickdrawSocket,
} from "./connection";
import { refusalAt, ticketOf, type Ticket } from "./issuer";
import { failBuffered, type CallHold } from "./socket";
import { notifyEach } from "./watch";

/**
 * What Socket.IO's client fails an acknowledgement with when its time limit
 * passes; with the socket down, the packet was still in its send buffer,
 * which drops it. Any other failure while the socket is down (it says "socket
 * has been disconnected") came after the packet was sent.
 */
const UNSENT_TIMEOUT = "operation has timed out";

/** What the acknowledgement of a call taken back out of Socket.IO's send buffer is told: the call waits instead. */
const TAKEN_BACK = new Error("Taken back out of Socket.IO's send buffer, unsent");

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

/** The errors of calls whose connection dropped after they were sent: their outcome is unknown. */
const lostInFlight = new WeakSet<QuickdrawError>();

/**
 * True when `error` leaves a call's outcome unknown: a `TIMEOUT` (the
 * server may still be running it, or ran it and the answer was lost), or the
 * `INTERNAL` of a call whose connection dropped after it was sent. The write
 * may have been made: before sending it again, make sure the call is
 * idempotent (a create that carries an id the client made, which the server
 * keeps, fails `CONFLICT` the second time instead of writing a second row).
 * False for a refusal, and for a call that was never sent.
 *
 * @example
 * onError: (error) => setStatus(isUnknownOutcome(error) ? "checking" : "failed")
 */
export function isUnknownOutcome(error: unknown): boolean {
  return error instanceof QuickdrawError && (error.code === "TIMEOUT" || lostInFlight.has(error));
}

/** The error of a call whose time ran out before it was sent. */
function unsentError(): QuickdrawError {
  return internalError("Not sent: the connection to the server is down");
}

/** The error of a call whose connection dropped after it was sent. */
function lostError(): QuickdrawError {
  const error = internalError("No answer: the connection to the server is down");
  lostInFlight.add(error);
  return error;
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
  if (!connection.socket.connected && !mayConnect(connection)) {
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

/** True when a send-buffer packet carries `envelope` itself: this emit's, not another with its id. */
function carries(data: unknown, envelope: CallEnvelope): boolean {
  return Array.isArray(data) && data[0] === CLIENT_EVENTS.call && data[1] === envelope;
}

/** True when a send-buffer packet is the `qd:call` frame of call `id`. */
function isQueuedCall(data: unknown, id: CallId): boolean {
  return (
    Array.isArray(data) && data[0] === CLIENT_EVENTS.call && isRecord(data[1]) && data[1].id === id
  );
}

/** What the acknowledgement of a call sent with a time limit of `limitMs` stands for. */
function outcomeOfAck(
  connection: QuickdrawConnection,
  kind: MethodKind,
  limitMs: number,
  error: Error | null,
  reply: unknown,
): CallResult | QuickdrawError {
  if (error === null) {
    return readReply(connection, kind, reply);
  }
  if (error instanceof QuickdrawError) {
    // Failed by the connection before it was sent (new credentials).
    return error;
  }
  if (connection.socket.connected) {
    return new QuickdrawError("TIMEOUT", `No answer within ${limitMs} ms`);
  }
  // Still in the send buffer when its time ran out (a connection made elsewhere), Socket.IO drops
  // it unsent; else it was sent, and the connection dropped: Socket.IO fails the answers it awaits.
  return error.message === UNSENT_TIMEOUT ? unsentError() : lostError();
}

/**
 * Holds a call in `hold`, `connection`'s, until its socket's hello, which
 * `send`s it with the time it has left when it names the user `ticket` was
 * made as, and else `settle`s it with its refusal; the connection's own
 * failure (new credentials, `close`, a session refused) and its time running
 * out settle it unsent. Returns the function that lets it go.
 */
function holdUntilConfirmed(
  hold: CallHold,
  connection: QuickdrawConnection,
  ticket: Ticket,
  deadline: number,
  send: (ms: number) => void,
  settle: (outcome: QuickdrawError) => void,
): () => void {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const release = hold.hold({
    confirmed(hello) {
      clearTimeout(timer);
      const refusal = refusalAt(ticket, hello, connection);
      const left = deadline - Date.now();
      if (refusal !== undefined) {
        settle(refusal);
      } else if (left > 0) {
        send(left);
      } else {
        settle(unsentError());
      }
    },
    failed(error) {
      clearTimeout(timer);
      settle(error);
    },
  });
  timer = setTimeout(
    () => {
      release();
      settle(unsentError());
    },
    Math.max(0, deadline - Date.now()),
  );
  return () => {
    clearTimeout(timer);
    release();
  };
}

/**
 * Emits call `envelope` on `socket` with time limit `ms`, telling `answered`
 * its acknowledgement. Returns false when Socket.IO kept it in its send
 * buffer though the socket reads connected (the engine under it is gone:
 * the server's ping is overdue) and `takeBack` says to take it back out:
 * the next connect would send it before that socket's hello. Its
 * acknowledgement is then never told anything.
 */
function emitCall(
  socket: QuickdrawSocket,
  envelope: CallEnvelope,
  ms: number,
  answered: (error: Error | null, reply: unknown) => void,
  takeBack: boolean,
): boolean {
  socket.timeout(ms).emit(CLIENT_EVENTS.call, envelope, (error: Error | null, reply: unknown) => {
    if (error !== TAKEN_BACK) {
      answered(error, reply);
    }
  });
  const taken = takeBack
    ? failBuffered(socket, TAKEN_BACK, (packet) => carries(packet.data, envelope))
    : 0;
  return taken === 0;
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
  // Bound to the user it is made as: it goes out only on a socket whose hello names them.
  const ticket = ticketOf(connection);
  const deadline = Date.now() + timeoutMs;
  return new Promise<CallResult<Output>>((resolve, reject) => {
    let settled = false;
    let sent = false;
    let letGo = (): void => undefined;
    const settle = (outcome: CallResult | QuickdrawError): void => {
      if (settled) {
        return;
      }
      settled = true;
      letGo();
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
      if (sent) {
        cancelCall(socket, id);
      }
      settle(cancelledError());
    }
    const hold = callHoldOf(connection);
    const answered = (error: Error | null, reply: unknown): void => {
      settle(outcomeOfAck(connection, kind, timeoutMs, error, reply));
    };
    const send = (ms: number): void => {
      sent = emitCall(socket, envelopeOf(id, request), ms, answered, hold !== undefined);
      if (!sent && hold !== undefined) {
        // Kept for the next connect, which would send it before that socket's hello: wait for it.
        letGo = holdUntilConfirmed(hold, connection, ticket, deadline, send, settle);
      }
    };
    // A socket without a hello of its own may speak for someone else (a cookie): wait for it.
    if (hold === undefined || (hold.confirmed && socket.connected)) {
      send(timeoutMs);
    } else {
      letGo = holdUntilConfirmed(hold, connection, ticket, deadline, send, settle);
    }
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
