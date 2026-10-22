// What a tool call runs as: the principal the registry's `principal` hook
// maps the session or token to, or the one an app that signed the caller in
// itself gives the call (`McpCallOptions.principal`, which skips the hook
// and gets its grants loaded as `qd.caller`'s are), the `ctx.mcp` fields
// the `context` hook adds, and a synthetic connection id: the concurrency
// lane its queries share (RFC 0003 section 9, step 2), as a socket's
// queries do. A stdio session is one lane; an HTTP request's lane is its
// caller's (`lanes.ts`; the 5.1 audit's MCP-4): its bearer token's, its
// user's without a token, or its address's when anonymous. A hook's refusal
// (`QuickdrawError` `UNAUTHENTICATED` or `FORBIDDEN`) is logged at debug.

import type { Logger } from "../../contract/logger";
import { QuickdrawError } from "../../protocol/errors";
import { callerGrantsOf, lazyMembers, withCallerGrants, type CallOptions } from "../caller";
import { toQuickdrawError } from "../pipeline/errors";
import { describeError } from "../pipeline/metrics";
import type { DispatchRequest, DispatchResult } from "../pipeline/request";
import { isForbiddenCredential, isPrincipal, isRefusal, toPrincipal } from "../transports/auth";
import type { McpContext, Principal } from "../types";
import { laneOf } from "./lanes";
import type { McpCallOptions, McpCallResult, McpRequest } from "./types";

/** Who a tool call acts for, what it adds to `ctx.mcp`, and the connection it counts against. */
export interface McpSession {
  readonly principal: Principal | null;
  readonly mcp: McpContext | undefined;
  readonly connectionId: string;
}

/** The registry's `principal` option, as the bridge calls it. */
export type PrincipalHook = (request: McpRequest) => unknown;

/** The registry's `context` option, as the bridge calls it. */
export type ContextHook = (request: McpRequest, principal: Principal | null) => unknown;

/** What resolving sessions and making calls in them needs. */
export interface SessionSettings {
  readonly dispatcher: { call(request: DispatchRequest): Promise<DispatchResult> };
  readonly principal: PrincipalHook | undefined;
  readonly context: ContextHook | undefined;
  readonly logger: Logger;
}

const CATEGORY = "quickdraw.mcp";

async function principalOf(
  settings: SessionSettings,
  request: McpRequest,
): Promise<Principal | null> {
  if (settings.principal === undefined) {
    return null;
  }
  try {
    return toPrincipal(await settings.principal(request));
  } catch (error) {
    // A refusal the hook made on purpose is the caller's doing; a hook that broke is the app's.
    const refused = isRefusal(error) || isForbiddenCredential(error);
    settings.logger[refused ? "debug" : "error"]("MCP authentication failed", {
      category: CATEGORY,
      transport: request.transport,
      error: describeError(error),
    });
    throw new QuickdrawError("UNAUTHENTICATED", "Authentication failed");
  }
}

async function contextOf(
  settings: SessionSettings,
  request: McpRequest,
  principal: Principal | null,
): Promise<McpContext | undefined> {
  if (settings.context === undefined) {
    return undefined;
  }
  const fields: unknown = await settings.context(request, principal);
  if (fields === undefined) {
    return undefined;
  }
  if (typeof fields !== "object" || fields === null) {
    throw new TypeError("createMcpRegistry: context must return an object, the fields of ctx.mcp");
  }
  return fields as McpContext;
}

/**
 * The principal an app gave a call: `null` or `undefined` for an anonymous
 * caller. Anything else that is no principal is a `TypeError`: the app's
 * mistake, never the caller's refusal.
 */
function givenPrincipal(principal: unknown): Principal | null {
  if (principal === null || principal === undefined) {
    return null;
  }
  if (!isPrincipal(principal)) {
    throw new TypeError(
      "An MCP call's principal must be a principal with a non-empty string userId, or null",
    );
  }
  return principal;
}

/**
 * Resolves who a call acts for and its `ctx.mcp` fields. With a `principal`
 * key in `options` (`null` included), that principal, with the grants the
 * dispatcher's in-process callers load when it carries none (as
 * `qd.caller`'s, at each call; a failed load rejects with `INTERNAL`), and
 * the registry's `principal` hook is not asked; else the hook's, rejecting
 * with `UNAUTHENTICATED` when the hook fails. A failing `context` hook
 * rejects with its own error.
 */
export async function openSession(
  settings: SessionSettings,
  options: Pick<McpCallOptions, "request" | "principal">,
): Promise<McpSession> {
  const { request } = options;
  const principal = Object.hasOwn(options, "principal")
    ? await withCallerGrants(givenPrincipal(options.principal), callerGrantsOf(settings.dispatcher))
    : await principalOf(settings, request);
  const mcp = await contextOf(settings, request, principal);
  return { principal, mcp, connectionId: laneOf(request, principal) };
}

/** A failed call's result. An `INTERNAL` failure is logged with what was thrown. */
export function failure(settings: SessionSettings, error: unknown, tool: string): McpCallResult {
  const converted = toQuickdrawError(error);
  if (converted.code === "INTERNAL") {
    settings.logger.error(`The MCP tool "${tool}" failed`, {
      category: CATEGORY,
      tool,
      error: describeError(converted),
    });
  }
  return { ok: false, error: converted };
}

/**
 * Hands `result` to the transport's `respond`, when it gave one, and returns
 * it. An error `respond` throws is logged and does not change the result.
 */
export function settle(
  settings: SessionSettings,
  options: McpCallOptions,
  result: McpCallResult,
): McpCallResult {
  try {
    options.respond?.(result);
  } catch (error) {
    settings.logger.error("An MCP transport failed to send a reply", {
      category: CATEGORY,
      error: describeError(error),
    });
  }
  return result;
}

/** A dispatcher result as a tool call's result. MCP calls never send a version, so never "not modified". */
export function fromDispatch(result: DispatchResult): McpCallResult {
  if (!result.ok) {
    return { ok: false, error: result.error };
  }
  return { ok: true, data: result.notModified === true ? undefined : result.data };
}

/** The dispatcher request of one method call made in `session`. */
export function sessionRequest(
  session: McpSession,
  call: Pick<DispatchRequest, "service" | "method" | "input" | "signal" | "respond">,
): DispatchRequest {
  return {
    ...call,
    principal: session.principal,
    transport: "mcp",
    connectionId: session.connectionId,
    mcp: session.mcp,
  };
}

type MethodFunction = (input?: unknown, options?: CallOptions) => Promise<unknown>;

/**
 * An in-process caller acting in `session`: each call goes through the
 * dispatcher as an MCP call, with the session's principal, connection and
 * `ctx.mcp`, so a custom tool cannot reach past what the agent may do.
 */
export function sessionCaller(
  settings: SessionSettings,
  session: McpSession,
  signal: AbortSignal,
): object {
  return lazyMembers((service) =>
    lazyMembers<MethodFunction>((method) => async (input, options) => {
      const request = sessionRequest(session, {
        service,
        method,
        input,
        signal: options?.signal ?? signal,
      });
      const result = await settings.dispatcher.call(request);
      if (!result.ok) {
        throw result.error;
      }
      return result.notModified === true ? undefined : result.data;
    }),
  );
}
