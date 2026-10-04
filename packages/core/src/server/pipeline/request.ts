// What a transport hands the dispatcher for one call, and what it gets back.
// Every transport (Socket.IO, HTTP, MCP, in-process, the 4.x shim) builds a
// `DispatchRequest`; the reply goes out through `respond`, so the pipeline
// can measure its size and flush only after it was sent (RFC 0003 section 9,
// step 9).

import type { CallReply, CallSuccess, Version } from "../../protocol/envelope";
import { toWire, type QuickdrawError } from "../../protocol/errors";
import type { McpContext, Principal, Transport } from "../types";

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

/**
 * A shared run's result as one group of its callers receives it: every
 * caller whose levels hide the same fields gets the same `data`, and its JSON
 * text is written once for all of them (RFC 0003 section 9, step 6). The
 * dispatcher hands it to `respond` beside the result.
 */
export interface SharedData {
  /** The `data` of the result it was handed with. */
  readonly data: unknown;
  /**
   * `data` as JSON text, written the first time any caller of the group asks
   * and reused after: what `JSON.stringify(data)` returns, `undefined`
   * included. Throws what `JSON.stringify` throws.
   */
  json(): string | undefined;
}

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
   * The fields the MCP bridge's `context` option produced for this call,
   * which the handler reads as `ctx.mcp`. Only the MCP transport sets it.
   */
  readonly mcp?: McpContext;
  /**
   * Sends the result to the caller and returns the reply's size in bytes,
   * when the transport measured it. Called once, before the flush and the
   * completion record. An error it throws is logged and does not change the
   * result. For data taken from a shared run, `shared` carries that data's
   * JSON text, written once for every caller that receives the same copy;
   * a transport that writes JSON may send it instead of encoding the data
   * again.
   */
  readonly respond?: (result: DispatchResult, shared?: SharedData) => number | undefined;
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

/**
 * The JSON text of a `qd:call` acknowledgement that carries data, written
 * around `dataJson`, the data's own JSON text: what `JSON.stringify(reply)`
 * writes, without encoding the data again.
 */
export function callReplyJson(reply: CallSuccess, dataJson: string): string {
  const version = reply.v === undefined ? "" : `,"v":${JSON.stringify(reply.v)}`;
  return `{"ok":true,"d":${dataJson}${version}}`;
}
