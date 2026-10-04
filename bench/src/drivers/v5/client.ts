import { QuickdrawError } from "@fitzzero/quickdraw-core";
import {
  call,
  createQuickdrawConnection,
  type CallRequest,
  type CallResult,
  type QuickdrawConnection,
} from "@fitzzero/quickdraw-core/client";
import type { Outcome, Recorder } from "../../recorder";
import type { DriverContext } from "../types";

/**
 * One client connection on the 5.0 client's own connection layer
 * (`createQuickdrawConnection`): the v5 handshake, the JSON-only parser,
 * `qd:hello`, the subscription lane, change topics and rate-limit backoff,
 * exactly as a 5.0 web client runs them. The harness only adds timing:
 *
 * - method calls are timed around the client's `call()`, from the call to
 *   its answer, keyed `<service>:<method>`; a call the client refuses
 *   before sending it (during a `RATE_LIMITED` backoff) counts as an error;
 * - the subscription frames the 5.0 client sends itself (`qd:sub`,
 *   `qd:col:sub`, `qd:col:items`, `qd:watch`) are timed from emit to
 *   acknowledgement, keyed `<service>:<event>`, by wrapping the socket's
 *   `emit`; the frames and their pacing are the client's.
 */

/** Subscription frames answered through an acknowledgement. */
const TIMED_EVENTS = new Set(["qd:sub", "qd:col:sub", "qd:col:items", "qd:watch"]);

/** How long to wait for a connection and its `qd:hello`. */
const CONNECT_TIMEOUT_MS = 30_000;

/** Called with each timed subscription frame's outcome when its acknowledgement arrives. */
export type AckListener = (event: string, outcome: Outcome) => void;

function field(value: unknown, key: string): unknown {
  return typeof value === "object" && value !== null
    ? (value as Record<string, unknown>)[key]
    : undefined;
}

function replyOutcome(error: unknown, reply: unknown, connected: boolean): Outcome {
  if (error !== null && error !== undefined) {
    return connected ? { ok: false, reason: "timeout" } : { ok: false, reason: "abandoned" };
  }
  if (field(reply, "ok") === true) {
    return { ok: true, data: reply };
  }
  const failure = field(reply, "e");
  return {
    ok: false,
    reason: "error",
    error: `${String(field(failure, "code"))}: ${String(field(failure, "message"))}`,
  };
}

/** The untyped face of the client's socket that the timing wraps. */
interface EmittingSocket {
  emit: (event: string, ...args: unknown[]) => unknown;
  readonly connected: boolean;
  readonly flags?: { readonly timeout?: number };
}

/** Times every subscription frame the 5.0 client sends on `connection`. */
function timeSubscriptionFrames(
  connection: QuickdrawConnection,
  recorder: Recorder,
  onAck: AckListener | undefined,
): void {
  const socket = connection.socket as unknown as EmittingSocket;
  const emit = socket.emit.bind(socket);
  socket.emit = (event, ...args) => {
    const last = args.length - 1;
    const ack = args[last];
    if (!TIMED_EVENTS.has(event) || last < 1 || typeof ack !== "function") {
      return emit(event, ...args);
    }
    // The client sends these with `socket.timeout(ms)`: the ack then takes an error first.
    const withError = socket.flags?.timeout !== undefined;
    const tracked = recorder.begin(`${String(field(args[0], "s"))}:${event}`);
    const startedAt = performance.now();
    args[last] = (...reply: unknown[]): unknown => {
      const outcome = withError
        ? replyOutcome(reply[0], reply[1], socket.connected)
        : replyOutcome(null, reply[0], socket.connected);
      tracked.finish(outcome, performance.now() - startedAt);
      onAck?.(event, outcome);
      return (ack as (...values: unknown[]) => unknown)(...reply);
    };
    return emit(event, ...args);
  };
}

/** A 5.0 client connection to the bench server, with its frames timed. */
export function openConnection(
  ctx: DriverContext,
  token: string,
  onAck?: AckListener,
): QuickdrawConnection {
  const connection = createQuickdrawConnection({ url: ctx.url, auth: token });
  timeSubscriptionFrames(connection, ctx.recorder, onAck);
  return connection;
}

/** What a failed call counts as. */
function failureOf(error: unknown, connection: QuickdrawConnection): Outcome {
  if (!(error instanceof QuickdrawError)) {
    return { ok: false, reason: "error", error: String(error) };
  }
  if (error.code === "TIMEOUT") {
    return { ok: false, reason: "timeout" };
  }
  // A call cut off by the client's own disconnect can never be answered.
  if (error.code === "CANCELLED" || (error.code === "INTERNAL" && !connection.socket.connected)) {
    return { ok: false, reason: "abandoned" };
  }
  return { ok: false, reason: "error", error: `${error.code}: ${error.message}` };
}

/** What a recorded call settled with: its outcome, and the result or the error `call()` gave. */
export type RecordedCall =
  | { readonly outcome: Outcome; readonly result: CallResult; readonly error?: undefined }
  | { readonly outcome: Outcome; readonly result?: undefined; readonly error: unknown };

/** One method call through the 5.0 client's `call()`, timed and recorded. */
export async function recordedCall(
  recorder: Recorder,
  connection: QuickdrawConnection,
  request: CallRequest,
): Promise<RecordedCall> {
  const tracked = recorder.begin(`${request.service}:${request.method}`);
  const startedAt = performance.now();
  let recorded: RecordedCall;
  try {
    const result = await call(connection, request);
    recorded = { outcome: { ok: true, data: result }, result };
  } catch (error) {
    recorded = { outcome: failureOf(error, connection), error };
  }
  tracked.finish(recorded.outcome, performance.now() - startedAt);
  return recorded;
}

/** One method call, timed and recorded; resolves with its outcome. */
export async function timedCall(
  recorder: Recorder,
  connection: QuickdrawConnection,
  request: CallRequest,
): Promise<Outcome> {
  return (await recordedCall(recorder, connection, request)).outcome;
}

/** True when queries may run: connected (or reconnecting), the hello in, no query backoff. */
export function queriesMayRun(connection: QuickdrawConnection): boolean {
  const state = connection.getState();
  const open = state.status === "connected" || state.reconnecting;
  return open && state.backoff.query === undefined && state.hello !== null;
}

/** Resolves once the connection is connected and holds the server's `qd:hello`. */
export async function untilHello(connection: QuickdrawConnection): Promise<void> {
  const ready = (): boolean => {
    const state = connection.getState();
    return state.status === "connected" && state.hello !== null;
  };
  if (ready()) return;
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => {
      stop();
      reject(new Error(`no connection and hello within ${CONNECT_TIMEOUT_MS} ms`));
    }, CONNECT_TIMEOUT_MS);
    const stop = connection.subscribe(() => {
      const state = connection.getState();
      if (ready()) {
        clearTimeout(timer);
        stop();
        resolve();
      } else if (state.status === "refused") {
        clearTimeout(timer);
        stop();
        reject(new Error(`the server refused the connection: ${JSON.stringify(state.refusal)}`));
      }
    });
  });
}
