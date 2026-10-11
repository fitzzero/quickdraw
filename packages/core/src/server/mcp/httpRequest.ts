// What a request to the MCP HTTP routes stands for, and whether the routes
// take it. `requestOf` makes each request a session of its own: a random
// session id, which hooks see, and its bearer token. `requestGate` refuses a
// request from a web page whose `Origin` `allowedOrigins` does not list
// (none by default), and, with `allowedHosts`, one for a `Host` it does not
// list (the 5.1 audit's MCP-3): a page an agent's user opens could otherwise
// call the routes from their browser, and a DNS-rebinding page could reach a
// server listening on their machine. A request without an `Origin` is no
// page's: an MCP client sends none.

import { randomUUID } from "node:crypto";
import type { IncomingMessage } from "node:http";
import { originAllowlist, type AllowedOrigin } from "../auth/routes/origins";
import type { McpHttpRequest } from "./types";

export type { AllowedOrigin };

/** The session an `invoke` request stands for, with its bearer token. */
export function requestOf(req: IncomingMessage): McpHttpRequest {
  const header = req.headers.authorization;
  const token = typeof header === "string" && header.startsWith("Bearer ") ? header.slice(7) : "";
  return {
    transport: "http",
    sessionId: randomUUID(),
    token: token.trim() === "" ? null : token.trim(),
    headers: req.headers,
    req,
  };
}

/** Why the routes refuse a request, before either route runs. */
export interface RequestGate {
  /** Why the routes refuse `req`, or `undefined` when they take it. */
  refusal(req: IncomingMessage): string | undefined;
}

function checkHosts(hosts: unknown): readonly string[] | undefined {
  if (hosts === undefined) {
    return undefined;
  }
  const valid =
    Array.isArray(hosts) &&
    hosts.length > 0 &&
    hosts.every((host) => typeof host === "string" && host !== "" && !/[\s/]/u.test(host));
  if (!valid) {
    throw new TypeError(
      'createMcpHttpRouter: allowedHosts must list host names, such as "localhost" or "mcp.example.com:8443"',
    );
  }
  return Object.freeze((hosts as readonly string[]).map((host) => host.toLowerCase()));
}

/** True when the `Host` header names one of `hosts`; an entry without a port matches any port. */
function hostAllowed(hosts: readonly string[], header: string | undefined): boolean {
  if (header === undefined || header === "") {
    return false;
  }
  let url: URL;
  try {
    url = new URL(`http://${header}`);
  } catch {
    return false;
  }
  return hosts.includes(url.host) || hosts.includes(url.hostname);
}

/** The gate of the routes made with `allowedOrigins` and `allowedHosts`, both checked. */
export function requestGate(allowedOrigins: unknown, allowedHosts: unknown): RequestGate {
  const origins = originAllowlist(
    (allowedOrigins ?? []) as readonly AllowedOrigin[],
    "createMcpHttpRouter",
    true,
  );
  const hosts = checkHosts(allowedHosts);
  return Object.freeze({
    refusal(req: IncomingMessage): string | undefined {
      const { origin, host } = req.headers;
      if (origin !== undefined && origins.allowed(origin) === null) {
        return "The MCP routes refuse requests from web pages unless allowedOrigins lists their origin";
      }
      if (hosts !== undefined && !hostAllowed(hosts, host)) {
        return "The MCP routes do not answer for this host";
      }
      return undefined;
    },
  });
}
