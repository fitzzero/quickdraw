// The concurrency lane of an MCP call: the connection id its queries count
// against (RFC 0003 section 9, step 2), as a socket's queries count against
// their socket. A stdio session is one lane. Each HTTP request is a session
// of its own, so its lane is its caller's (the 5.1 audit's MCP-4):
//
// - with a bearer token, the token's, by a hash (never the token itself). A
//   `principal` hook that authenticates by anything else (a cookie, an API
//   key header) must refuse a request whose bearer token it does not
//   verify: otherwise a caller makes a lane per made-up token;
// - for a principal without a token, its user's;
// - when anonymous, its address's: Express's `req.ip`, which follows the
//   app's `trust proxy` (behind a proxy without it, every anonymous caller
//   shares the proxy's lane), else the socket's. An IPv4-mapped IPv6
//   address counts as its IPv4 address, and an IPv6 address by its /56,
//   since one host commonly holds a /64 or more (as express-rate-limit
//   keys them).

import { createHash } from "node:crypto";
import { isIPv6 } from "node:net";
import type { Principal } from "../types";
import type { McpRequest } from "./types";

/** The eight 16-bit groups of a valid IPv6 address. */
function groupsOf(address: string): number[] {
  // The URL parser writes an embedded IPv4 address as two groups, and compresses one run of zeros.
  const written = new URL(`http://[${address}]/`).hostname.slice(1, -1);
  const [head = "", tail = ""] = written.split("::");
  const parse = (part: string): number[] =>
    part === "" ? [] : part.split(":").map((group) => Number.parseInt(group, 16));
  const before = parse(head);
  const after = parse(tail);
  return [...before, ...new Array<number>(8 - before.length - after.length).fill(0), ...after];
}

/**
 * The address an anonymous caller's lane is named by: an IPv4 address as it
 * is, an IPv4-mapped IPv6 address as its IPv4 address, another IPv6 address
 * as its /56 network, and anything else as it is.
 */
export function addressLane(ip: string): string {
  const address = ip.split("%", 1)[0] ?? ip;
  if (!isIPv6(address)) {
    return ip;
  }
  const [a = 0, b = 0, c = 0, d = 0, e = 0, f = 0, g = 0, h = 0] = groupsOf(address);
  if (a === 0 && b === 0 && c === 0 && d === 0 && e === 0 && f === 0xffff) {
    return [g >> 8, g & 0xff, h >> 8, h & 0xff].join(".");
  }
  // The first 56 bits: three groups, and the high byte of the fourth.
  return `${[a, b, c, d & 0xff00].map((group) => group.toString(16)).join(":")}::/56`;
}

/** The address an HTTP request came from: Express's `req.ip` (which honors trust proxy), or the socket's. */
function addressOf(request: McpRequest & { readonly transport: "http" }): string {
  const { ip } = request.req as { readonly ip?: unknown };
  return typeof ip === "string" && ip !== ""
    ? ip
    : (request.req.socket?.remoteAddress ?? "unknown");
}

/** The lane a call's queries share: its stdio session's, or its HTTP caller's. */
export function laneOf(request: McpRequest, principal: Principal | null): string {
  if (request.transport === "stdio") {
    return `mcp:${request.sessionId}`;
  }
  if (principal === null) {
    return `mcp:http:address:${addressLane(addressOf(request))}`;
  }
  if (request.token === null) {
    return `mcp:http:user:${principal.userId}`;
  }
  const hash = createHash("sha256").update(request.token).digest("base64url").slice(0, 22);
  return `mcp:http:token:${hash}`;
}
