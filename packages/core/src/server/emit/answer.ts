// How the live data's socket listeners answer (RFC 0003 section 8.2): the
// entity, collection and topic events share these, so none of them throws.
// Socket.IO runs listeners from `process.nextTick`, where an exception ends
// the process: whatever a frame makes go wrong is logged and answered
// `INTERNAL` instead. The events that read the database (`qd:sub`,
// `qd:col:sub`, `qd:col:items`, `qd:watch`) run in the socket's lane of
// subscription work (`lane.ts`).

import type { Failure } from "../../protocol/envelope";
import { toWire } from "../../protocol/errors";
import { toQuickdrawError } from "../pipeline/errors";
import { describeError } from "../pipeline/metrics";
import { acknowledge, INTERNAL_FAILURE, type Acknowledge } from "../transports/ack";
import type { QuickdrawServerSocket, SocketContext } from "../transports/types";
import { laneOf } from "./lane";

/** Acknowledges a subscription event, when the client asked for an acknowledgement. Never throws. */
export function reply(
  socket: QuickdrawServerSocket,
  context: SocketContext,
  ack: unknown,
  message: unknown,
): void {
  if (typeof ack !== "function") {
    return;
  }
  acknowledge(context.meter, ack as Acknowledge, message, INTERNAL_FAILURE, (error) => {
    context.logger.error(
      "A subscription reply could not be encoded; it was answered with INTERNAL",
      {
        category: "quickdraw.socket",
        socketId: socket.id,
        error: describeError(error),
      },
    );
  });
}

/** The failure a frame's handler answers with for what it threw; an `INTERNAL` one is logged. */
export function failureOf(
  context: Pick<SocketContext, "logger">,
  socket: QuickdrawServerSocket,
  event: string,
  error: unknown,
): Failure {
  const failure = toQuickdrawError(error);
  if (failure.code === "INTERNAL") {
    context.logger.error(`A ${event} failed`, {
      category: "quickdraw.socket",
      socketId: socket.id,
      error: describeError(failure.cause ?? failure),
    });
  }
  return { ok: false, e: toWire(failure) };
}

/**
 * Answers a frame whose handler is synchronous with what `work` returns, or
 * with the failure what it threw maps to (`INTERNAL`, logged, for anything
 * but a `QuickdrawError`). Never throws.
 */
export function answerNow(
  socket: QuickdrawServerSocket,
  context: SocketContext,
  event: string,
  ack: unknown,
  work: () => unknown,
): void {
  let answer: unknown;
  try {
    answer = work();
  } catch (error) {
    answer = failureOf(context, socket, event, error);
  }
  reply(socket, context, ack, answer);
}

/**
 * Answers a frame whose handler is asynchronous with what `work` resolves
 * with, or with the failure its rejection maps to. Never throws, and the
 * promise it starts never rejects.
 */
export function answerLater(
  socket: QuickdrawServerSocket,
  context: SocketContext,
  event: string,
  ack: unknown,
  work: () => Promise<unknown>,
): void {
  const settled = (async () => {
    try {
      return await work();
    } catch (error) {
      return failureOf(context, socket, event, error);
    }
  })();
  void settled.then((answer) => {
    reply(socket, context, ack, answer);
  });
}

/** Runs `cleanup` when the socket disconnects; what it throws is logged, never thrown. */
export function onDisconnect(
  socket: QuickdrawServerSocket,
  context: Pick<SocketContext, "logger">,
  cleanup: () => void,
): void {
  socket.on("disconnect", () => {
    try {
      cleanup();
    } catch (error) {
      context.logger.error("Cleaning up a disconnected socket's live data failed", {
        category: "quickdraw.socket",
        socketId: socket.id,
        error: describeError(error),
      });
    }
  });
}

/**
 * Registers a listener for a subscription event a client sends with an
 * acknowledgement, answered by `work` run in the socket's lane
 * (`answerLater`): `RATE_LIMITED` when the lane is full. An event sent
 * without an acknowledgement is ignored.
 */
export function answerEvent(
  socket: QuickdrawServerSocket,
  context: SocketContext,
  event: string,
  work: (frame: unknown) => Promise<unknown>,
): void {
  const lane = laneOf(socket, context);
  socket.on(event, (frame: unknown, ack: unknown) => {
    if (typeof ack !== "function") {
      context.logger.debug(`Ignored a ${event} sent without an acknowledgement`, {
        category: "quickdraw.socket",
        socketId: socket.id,
      });
      return;
    }
    answerLater(socket, context, event, ack, () => lane(() => work(frame)));
  });
}
