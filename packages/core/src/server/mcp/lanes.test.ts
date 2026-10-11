// The lane an MCP call's queries count against (the 5.1 audit's MCP-4, and
// its review): an anonymous HTTP caller's address, read from Express's
// `req.ip` first, with an IPv6 caller counted by its /56 and an IPv4-mapped
// one by its IPv4 address; a principal without a token, its user; a token,
// by a hash that never holds the token.

import type { IncomingMessage } from "node:http";
import { describe, expect, it } from "vitest";
import { addressLane, laneOf } from "./lanes";
import type { McpRequest } from "./types";

/** An HTTP request with `token`, whose Express `req.ip` is `ip` and whose socket is `remoteAddress`'s. */
function http(token: string | null, req: { ip?: string; remoteAddress?: string }): McpRequest {
  return {
    transport: "http",
    sessionId: "session-1",
    token,
    headers: {},
    req: { ip: req.ip, socket: { remoteAddress: req.remoteAddress } } as unknown as IncomingMessage,
  };
}

describe("an MCP call's lane", () => {
  it("is an IPv6 caller's /56, and an IPv4-mapped caller's IPv4 address", () => {
    expect(addressLane("10.0.0.1")).toBe("10.0.0.1");
    expect(addressLane("::ffff:10.0.0.1")).toBe("10.0.0.1");
    expect(addressLane("0:0:0:0:0:ffff:a00:1")).toBe("10.0.0.1");
    // One /56, whatever the rest: one host commonly holds a /64 or more.
    expect(addressLane("2001:db8:1:2::1")).toBe("2001:db8:1:0::/56");
    expect(addressLane("2001:DB8:1:ff:aaaa:bbbb:cccc:dddd")).toBe("2001:db8:1:0::/56");
    expect(addressLane("2001:db8:1:100::1")).toBe("2001:db8:1:100::/56");
    expect(addressLane("fe80::1%eth0")).toBe("fe80:0:0:0::/56");
    expect(addressLane("64:ff9b::1.2.3.4")).toBe("64:ff9b:0:0::/56");
    expect(addressLane("unknown")).toBe("unknown");
  });

  it("is an anonymous HTTP caller's address, Express's req.ip first", () => {
    expect(laneOf(http(null, { ip: "10.0.0.7", remoteAddress: "10.0.0.1" }), null)).toBe(
      "mcp:http:address:10.0.0.7",
    );
    expect(laneOf(http(null, { remoteAddress: "::ffff:10.0.0.1" }), null)).toBe(
      "mcp:http:address:10.0.0.1",
    );
    expect(laneOf(http(null, { ip: "2001:db8:1:2::1" }), null)).toBe(
      laneOf(http(null, { ip: "2001:db8:1:3::9" }), null),
    );
  });

  it("is a principal's user without a token, and a token's hash with one", () => {
    const ada = { userId: "ada" };
    expect(laneOf(http(null, { ip: "10.0.0.1" }), ada)).toBe("mcp:http:user:ada");
    const lane = laneOf(http("secret-token", { ip: "10.0.0.1" }), ada);
    expect(lane).toMatch(/^mcp:http:token:[\w-]{22}$/u);
    expect(lane).not.toContain("secret-token");
    expect(laneOf(http("secret-token", { ip: "10.0.0.2" }), { userId: "bo" })).toBe(lane);
    expect(laneOf({ transport: "stdio", sessionId: "s1" }, ada)).toBe("mcp:s1");
  });
});
