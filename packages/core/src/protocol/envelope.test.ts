import { describe, expect, it } from "vitest";
import { isCallEnvelope, isCancel } from "./envelope";

describe("isCallEnvelope", () => {
  it.each([
    [
      "a full envelope",
      { id: 1, s: "taskService", m: "get", i: { id: "t1" }, v: 1_759_400_000_000 },
    ],
    ["an envelope without input or version", { id: 0, s: "taskService", m: "list" }],
    ["a string version", { id: 2, s: "taskService", m: "stats", i: {}, v: "etag-3f9a" }],
    ["any input at all", { id: 3, s: "taskService", m: "get", i: [null, "x", 1] }],
    ["the largest safe call id", { id: Number.MAX_SAFE_INTEGER, s: "a", m: "b" }],
    ["unknown keys", { id: 4, s: "taskService", m: "get", i: null, trace: "abc" }],
    ["a decoded JSON envelope", JSON.parse('{"id":5,"s":"taskService","m":"get","i":{"id":"t1"}}')],
  ])("accepts %s", (_label, value) => {
    expect(isCallEnvelope(value)).toBe(true);
  });

  it.each([
    ["null", null],
    ["a string", "qd:call"],
    ["an array", [1, "taskService", "get", {}]],
    ["a missing id", { s: "taskService", m: "get" }],
    ["a string id", { id: "1", s: "taskService", m: "get" }],
    ["a negative id", { id: -1, s: "taskService", m: "get" }],
    ["a fractional id", { id: 1.5, s: "taskService", m: "get" }],
    ["an unsafe integer id", { id: 2 ** 53, s: "taskService", m: "get" }],
    ["a NaN id", { id: Number.NaN, s: "taskService", m: "get" }],
    ["a missing service", { id: 1, m: "get" }],
    ["an empty service", { id: 1, s: "", m: "get" }],
    ["a numeric method", { id: 1, s: "taskService", m: 7 }],
    ["an empty method", { id: 1, s: "taskService", m: "" }],
    ["a null version", { id: 1, s: "taskService", m: "get", v: null }],
    ["an object version", { id: 1, s: "taskService", m: "get", v: { rev: 1 } }],
    ["an infinite version", { id: 1, s: "taskService", m: "get", v: Number.POSITIVE_INFINITY }],
  ])("rejects %s", (_label, value) => {
    expect(isCallEnvelope(value)).toBe(false);
  });
});

describe("isCancel", () => {
  it("accepts a call id, ignoring unknown keys", () => {
    expect(isCancel({ id: 0 })).toBe(true);
    expect(isCancel({ id: 42, reason: "unmounted" })).toBe(true);
  });

  it.each([
    ["null", null],
    ["a bare id", 42],
    ["an empty object", {}],
    ["a string id", { id: "42" }],
    ["a negative id", { id: -3 }],
    ["a fractional id", { id: 0.5 }],
  ])("rejects %s", (_label, value) => {
    expect(isCancel(value)).toBe(false);
  });
});
