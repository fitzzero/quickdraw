// What a request to the MCP HTTP routes stands for, and whether the routes
// take it. `requestOf` makes each request a session of its own: a random
// session id, which hooks see, and its bearer token. `requestGate` refuses a
// request from a web page whose `Origin` `allowedOrigins` does not list
// (none by default), and, with `allowedHosts`, one for a `Host` it does not
// list (the 5.1 audit's MCP-3): a page an agent's user opens could otherwise
// call the routes from their browser, and a DNS-rebinding page could reach a
// server listening on their machine. A request without an `Origin` is no
// page's: an MCP client sends none. An `allowedHosts` entry is compared as a
// host: in any case, an IPv6 address with or without brackets, a name in
// Unicode or punycode, and a port when it writes one.

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

/**
 * A host as the gate compares it: its name (lower case, an IPv6 address in
 * brackets, a name in punycode), and its port when one is written.
 */
interface Host {
  readonly hostname: string;
  readonly port: string | undefined;
}

/** `value`, a host as a `Host` header or an `allowedHosts` entry writes it, or `undefined` when it is not one. */
function hostOf(value: string): Host | undefined {
  if (/\s/u.test(value)) {
    return undefined;
  }
  // A bare IPv6 address (two colons or more, no brackets) is a host without a port.
  const host = !value.startsWith("[") && value.split(":").length > 2 ? `[${value}]` : value;
  let url: URL;
  try {
    url = new URL(`http://${host}`);
  } catch {
    return undefined;
  }
  const extra = url.username + url.password + url.search + url.hash;
  if (url.hostname === "" || extra !== "" || url.pathname !== "/") {
    return undefined;
  }
  // The URL parser drops port 80, its scheme's default: whether a port is written is read from the text.
  const written = !host.endsWith("]") && /:\d+$/u.test(host);
  return { hostname: url.hostname, port: written ? url.port || "80" : undefined };
}

function checkHosts(hosts: unknown): readonly Host[] | undefined {
  if (hosts === undefined) {
    return undefined;
  }
  const parsed = Array.isArray(hosts)
    ? hosts.map((host: unknown) => (typeof host === "string" ? hostOf(host) : undefined))
    : [];
  if (parsed.length === 0 || parsed.includes(undefined)) {
    throw new TypeError(
      'createMcpHttpRouter: allowedHosts must list host names, such as "localhost" or "mcp.example.com:8443"',
    );
  }
  return Object.freeze(parsed as Host[]);
}

/**
 * True when the `Host` header names one of `hosts`. An entry without a port
 * matches any port; a header without one is for its scheme's default port,
 * 80 or 443.
 */
function hostAllowed(hosts: readonly Host[], header: string | undefined): boolean {
  const host = header === undefined ? undefined : hostOf(header);
  if (host === undefined) {
    return false;
  }
  const portMatches = (port: string): boolean =>
    host.port === undefined ? port === "80" || port === "443" : port === host.port;
  return hosts.some(
    (entry) =>
      entry.hostname === host.hostname && (entry.port === undefined || portMatches(entry.port)),
  );
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
