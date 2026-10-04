"use client";

// `useJoin(member, input, options)` (RFC 0003 sections 11 and 12.5): runs a
// joining call (a method whose handler puts the calling socket in an app
// room with `ctx.rooms.join`, a game's `watchWorld`, a board's `enterBoard`)
// on every `qd:hello`, not on every render. An app room belongs to one
// socket: a reconnect (a lost network, a `qd:rotate`, new credentials) is a
// new socket in no room, which hears none of the room's events and whose
// channel messages that require the room are dropped, while a query's cached
// answer still looks fine and nothing reads it again. 4.1 apps re-joined from
// `isConnected` effects by hand.
//
// - Each hello runs the call once more (`connection.onHello`), and so does a
//   new input (compared by value, as query keys are). A failure shows as
//   `error` until the next hello; `RATE_LIMITED` is tried again once its
//   backoff ends.
// - `status` is the current socket's: `"idle"` while there is none to join
//   with (before the first hello, while reconnecting) or `enabled` is false,
//   `"joining"` while the call runs, then `"joined"` or `"error"`. `data` is
//   what the last successful call returned, kept through a reconnect.
// - It never leaves a room: unmounting or disabling it stops the re-joins
//   only. Leave with a call of its own, or let the server's `onRoomLeave`
//   follow the socket's disconnect.
//
// It calls through `member.call`, so it works on a mock client's members
// too, whose provider gives a hello per session.

import { hashKey } from "@tanstack/react-query";
import { useEffect, useMemo, useRef, useState } from "react";
import { QuickdrawError } from "../protocol/errors";
import { DEFAULT_BACKOFF_MS, retryAfterOf } from "./backoff";
import { useConnectionState, useQuickdrawContext } from "./context";

/**
 * A member `useJoin` can run: any query or mutation member of the typed
 * client (`qd.game.watchWorld`), or of a mock client.
 */
export interface JoinMember<Input, Output> {
  call(input: Input): Promise<Output>;
}

/** Where a join stands on the current socket. */
export type JoinStatus = "idle" | "joining" | "joined" | "error";

/** Options of {@link useJoin}. */
export interface UseJoinOptions<Output> {
  /**
   * Joins only while true. Turning it false stops the re-joins (it does not
   * leave the room); turning it true again joins at once. Default `true`.
   */
  readonly enabled?: boolean;
  /** Called with what each successful join returned: once per socket. */
  readonly onJoined?: (data: Output) => void;
}

/** What {@link useJoin} returns. */
export interface UseJoinResult<Output> {
  /**
   * The current socket's join: `"idle"` while there is no socket to join
   * with (before the first hello, while reconnecting) or `enabled` is false,
   * `"joining"` while the call runs, `"joined"` once it succeeded, `"error"`
   * when it failed (see `error`).
   */
  readonly status: JoinStatus;
  /** `status === "joined"`. */
  readonly isJoined: boolean;
  /** What the last successful call returned, on this socket or an earlier one. */
  readonly data: Output | undefined;
  /** Why the call failed on the current socket; `null` otherwise. */
  readonly error: QuickdrawError | null;
}

/** The last join: the socket it ran on, and how it went. */
interface JoinState<Output> {
  readonly socketId: string | undefined;
  readonly status: Exclude<JoinStatus, "idle">;
  readonly data: Output | undefined;
  readonly error: QuickdrawError | null;
}

function failureOf(error: unknown): QuickdrawError {
  return error instanceof QuickdrawError
    ? error
    : new QuickdrawError("INTERNAL", error instanceof Error ? error.message : String(error));
}

/**
 * Runs `member.call(input)` on every `qd:hello` of the provider's connection
 * (the first one, every reconnect, new credentials) and when `input`
 * changes by value: the joining call of an app room, which a new socket must
 * make again. Not on re-renders.
 *
 * @example
 * // the socket is in the board's room on every connection, so its events and channel reach it
 * const board = useJoin(qd.task.enterBoard, { projectId });
 * if (board.status === "error") return <p>{board.error?.message}</p>;
 */
export function useJoin<Input, Output>(
  member: JoinMember<Input, Output>,
  input: Input,
  options: UseJoinOptions<Output> = {},
): UseJoinResult<Output> {
  const { connection } = useQuickdrawContext("useJoin");
  const connected = useConnectionState(connection).status === "connected";
  const enabled = options.enabled !== false;
  const key = hashKey([input]);
  const latest = useRef({ input, onJoined: options.onJoined });
  useEffect(() => {
    latest.current = { input, onJoined: options.onJoined };
  });
  const [state, setState] = useState<JoinState<Output> | undefined>(undefined);
  useEffect(() => {
    if (!enabled) {
      return undefined;
    }
    let attempt = 0;
    let stopped = false;
    let retry: ReturnType<typeof setTimeout> | undefined;
    const join = (): void => {
      clearTimeout(retry);
      attempt += 1;
      const mine = attempt;
      const socketId = connection.socket.id;
      const current = (): boolean => !stopped && mine === attempt;
      setState((previous) => ({ socketId, status: "joining", data: previous?.data, error: null }));
      member.call(latest.current.input).then(
        (data) => {
          if (current()) {
            setState({ socketId, status: "joined", data, error: null });
            latest.current.onJoined?.(data);
          }
        },
        (error: unknown) => {
          if (!current()) {
            return;
          }
          const failure = failureOf(error);
          setState((previous) => ({
            socketId,
            status: "error",
            data: previous?.data,
            error: failure,
          }));
          if (failure.code === "RATE_LIMITED") {
            retry = setTimeout(
              () => {
                // Only on the socket it was refused on: a new one's hello joins anyway.
                if (current() && connection.socket.id === socketId) {
                  join();
                }
              },
              retryAfterOf(failure) ?? DEFAULT_BACKOFF_MS,
            );
          }
        },
      );
    };
    const stop = connection.onHello(join);
    return () => {
      stopped = true;
      clearTimeout(retry);
      stop();
    };
  }, [connection, member, enabled, key]);
  const shown =
    enabled && connected && state !== undefined && state.socketId === connection.socket.id
      ? state
      : undefined;
  const status = shown?.status ?? "idle";
  const error = shown?.error ?? null;
  const data = state?.data;
  return useMemo(
    () => ({ status, isJoined: status === "joined", data, error }),
    [status, data, error],
  );
}
