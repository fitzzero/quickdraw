import { describe, expect, it } from "vitest";
import { PROTOCOL_MISMATCH, PROTOCOL_VERSION, isProtocolMismatch, isQdHandshake } from "./version";

describe("PROTOCOL_VERSION", () => {
  it("is 5", () => {
    expect(PROTOCOL_VERSION).toBe(5);
  });
});

describe("isQdHandshake", () => {
  it("accepts the auth.qd of RFC 0003 section 8.1", () => {
    expect(isQdHandshake({ protocol: 5, client: "5.0.0-alpha.0" })).toBe(true);
  });

  it("accepts another protocol, which the server then refuses", () => {
    expect(isQdHandshake({ protocol: 6, client: "6.0.0" })).toBe(true);
  });

  it.each([
    ["undefined (a 4.x client sends no auth.qd)", undefined],
    ["null", null],
    ["a bare version", 5],
    ["a string protocol", { protocol: "5", client: "5.0.0" }],
    ["a fractional protocol", { protocol: 5.1, client: "5.0.0" }],
    ["a missing client", { protocol: 5 }],
    ["a numeric client", { protocol: 5, client: 5 }],
  ])("rejects %s", (_label, value) => {
    expect(isQdHandshake(value)).toBe(false);
  });
});

describe("isProtocolMismatch", () => {
  it("recognizes the connect_error data of a refused connection", () => {
    expect(isProtocolMismatch({ code: PROTOCOL_MISMATCH, expected: 5 })).toBe(true);
  });

  it.each([
    ["another code", { code: "FORBIDDEN", expected: 5 }],
    ["a missing expected protocol", { code: PROTOCOL_MISMATCH }],
    ["a string expected protocol", { code: PROTOCOL_MISMATCH, expected: "5" }],
    ["a message string", "PROTOCOL_MISMATCH"],
    ["undefined", undefined],
  ])("rejects %s", (_label, value) => {
    expect(isProtocolMismatch(value)).toBe(false);
  });
});
