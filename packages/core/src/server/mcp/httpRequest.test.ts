// The MCP HTTP routes' gate (the 5.1 audit's MCP-3, and its review): a page's
// `Origin` is refused unless `allowedOrigins` lists it, an opaque one
// (`null`) included, and anchored patterns match whole origins; an
// `allowedHosts` entry is compared as a host, whatever its case, brackets or
// script, with its port when it writes one. `http.test.ts` sends real
// requests through the routes.

import type { IncomingMessage } from "node:http";
import { describe, expect, it } from "vitest";
import { requestGate } from "./httpRequest";

const request = (headers: Readonly<Record<string, string>>) =>
  ({ headers }) as unknown as IncomingMessage;

describe("the MCP routes' gate", () => {
  it("refuses a page's origin unless listed, an opaque one (null) included, and matches patterns whole", () => {
    const closed = requestGate(undefined, undefined);
    expect(closed.refusal(request({}))).toBeUndefined();
    expect(closed.refusal(request({ origin: "null" }))).toContain("allowedOrigins");
    expect(closed.refusal(request({ origin: "http://app.example" }))).toContain("allowedOrigins");
    const listed = requestGate([/^https:\/\/[a-z]+\.example\.com$/u], undefined);
    expect(listed.refusal(request({ origin: "https://app.example.com" }))).toBeUndefined();
    expect(listed.refusal(request({ origin: "https://app.example.com.evil.test" }))).toContain(
      "allowedOrigins",
    );
    expect(listed.refusal(request({ origin: "null" }))).toContain("allowedOrigins");
  });

  it("compares allowedHosts as hosts: IPv6 with or without brackets, any case, a name as punycode, a written port", () => {
    const gate = requestGate(undefined, [
      "::1",
      "LOCALHOST:4000",
      "bücher.example",
      "mcp.example.com:443",
      "[2001:db8::1]",
    ]);
    const refusal = (host: string) => gate.refusal(request({ host }));
    const refused = "do not answer for this host";
    expect(refusal("[::1]:4000")).toBeUndefined();
    expect(refusal("[::1]")).toBeUndefined();
    expect(refusal("localhost:4000")).toBeUndefined();
    expect(refusal("localhost:5000")).toContain(refused);
    expect(refusal("localhost")).toContain(refused);
    expect(refusal("xn--bcher-kva.example:8080")).toBeUndefined();
    // A Host without a port is for the scheme's default one, 80 or 443.
    expect(refusal("mcp.example.com")).toBeUndefined();
    expect(refusal("mcp.example.com:8443")).toContain(refused);
    expect(refusal("[2001:db8:0::1]:9000")).toBeUndefined();
    expect(refusal("attacker.example")).toContain(refused);
    expect(refusal("attacker.example/@localhost:4000")).toContain(refused);
    expect(gate.refusal(request({}))).toContain(refused);
  });

  it("refuses an allowedHosts entry that is not a host", () => {
    for (const entry of ["", "a/b", "user@host", "host name", "host:99999", "localhost ", "a?b"]) {
      expect(() => requestGate(undefined, [entry]), entry).toThrow(TypeError);
    }
    expect(() => requestGate(undefined, [])).toThrow(TypeError);
  });
});
