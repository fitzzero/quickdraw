// What a transport hands the dispatcher for one call, and what it gets back.
// Every transport (Socket.IO, HTTP, MCP, in-process, the 4.x shim) builds a
// `DispatchRequest`; the reply goes out through `respond`, so the pipeline
// can measure its size and flush only after it was sent (RFC 0003 section 9,
// step 9).

import type { CallReply, Version } from "../../protocol/envelope";
import { toWire, type QuickdrawError } from "../../protocol/errors";
import type { Principal, Transport } from "../types";

/** How one call ended. The dispatcher's `call` resolves with it and never rejects. */
export type DispatchResult =
  | {
      readonly ok: true;
      readonly data: unknown;
      /** The version of `data`, when the query has one; the caller sends it back as `v`. */
      readonly version?: Version;
      readonly notModified?: undefined;
    }
  | {
      /** The caller's version is current: it keeps its cached result. */
      readonly ok: true;
      readonly notModified: true;
      readonly version: Version;
    }
  | {
      readonly ok: false;
      /** Why the call failed. For `INTERNAL`, `cause` holds the original error; `toWire` never sends it. */
      readonly error: QuickdrawError;
    };

/** One method call, as a transport hands it to the dispatcher. */
export interface DispatchRequest {
  /** The service name. */
  readonly service: string;
  /** The method name. */
  readonly method: string;
  /** The input as received; the method's schema validates it. */
  readonly input: unknown;
  /** The authenticated caller, or `null` when anonymous. */
  readonly principal: Principal | null;
  readonly transport: Transport;
  /**
   * The connection the call arrived on. Queries are capped per connection;
   * a call without one (in-process, HTTP) is not capped.
   */
  readonly connectionId?: string;
  /** Aborts when the caller cancels the call or goes away. Only queries can be cancelled. */
  readonly signal?: AbortSignal;
  /** Identifies the call in logs; generated when absent. */
  readonly requestId?: string;
  /** The version of the result the caller already holds. */
  readonly v?: Version;
  /**
   * Sends the result to the caller and returns the reply's size in bytes,
   * when the transport measured it. Called once, before the flush and the
   * completion record. An error it throws is logged and does not change the
   * result.
   */
  readonly respond?: (result: DispatchResult) => number | undefined;
}

/** A dispatch result in the acknowledgement shape of `qd:call` (RFC 0003 section 8.2). */
export function toCallReply(result: DispatchResult): CallReply {
  if (!result.ok) {
    return { ok: false, e: toWire(result.error) };
  }
  if (result.notModified === true) {
    return { ok: true, nm: true, v: result.version };
  }
  return result.version === undefined
    ? { ok: true, d: result.data }
    : { ok: true, d: result.data, v: result.version };
}
