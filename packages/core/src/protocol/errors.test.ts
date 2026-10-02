import { describe, expect, it } from "vitest";
import {
  ERROR_CODES,
  INTERNAL_MESSAGE,
  QuickdrawError,
  fromWire,
  httpStatus,
  isErrorCode,
  toWire,
  type ErrorCode,
} from "./errors";

// The table in RFC 0003 section 3, written out here rather than derived from
// the implementation, so a change to either one fails this test.
const RFC_TABLE: [ErrorCode, number][] = [
  ["UNAUTHENTICATED", 401],
  ["FORBIDDEN", 403],
  ["NOT_FOUND", 404],
  ["CONFLICT", 409],
  ["VALIDATION", 422],
  ["RATE_LIMITED", 429],
  ["CANCELLED", 499],
  ["TIMEOUT", 504],
  ["INTERNAL", 500],
];

const SAMPLE_DATA: Partial<Record<ErrorCode, unknown>> = {
  VALIDATION: { issues: [{ path: ["items", 0, "title"], message: "Required" }] },
  RATE_LIMITED: { retryAfterMs: 1500 },
  CONFLICT: { field: "slug", nested: { list: [1, "two", null, true] } },
};

describe("error codes", () => {
  it("are exactly the codes of RFC 0003 section 3, in its order", () => {
    expect(ERROR_CODES).toEqual(RFC_TABLE.map(([code]) => code));
    expect(Object.isFrozen(ERROR_CODES)).toBe(true);
  });

  it.each(RFC_TABLE)("%s maps to HTTP %i", (code, status) => {
    expect(httpStatus(code)).toBe(status);
  });

  it("recognizes only the codes in the table", () => {
    for (const code of ERROR_CODES) {
      expect(isErrorCode(code)).toBe(true);
    }
    for (const value of ["internal", "PROTOCOL_MISMATCH", "toString", "__proto__", "", 500, null]) {
      expect(isErrorCode(value)).toBe(false);
    }
  });
});

describe("QuickdrawError", () => {
  it("is an Error with a code, a message and data", () => {
    const error = new QuickdrawError("FORBIDDEN", "Not yours", { id: "t1" });
    expect(error).toBeInstanceOf(Error);
    expect(error.name).toBe("QuickdrawError");
    expect(error.code).toBe("FORBIDDEN");
    expect(error.message).toBe("Not yours");
    expect(error.data).toEqual({ id: "t1" });
    expect(String(error)).toBe("QuickdrawError: Not yours");
  });

  it("has no data unless given some", () => {
    expect(new QuickdrawError("NOT_FOUND", "Gone").data).toBeUndefined();
  });
});

describe("toWire", () => {
  it.each(RFC_TABLE.filter(([code]) => code !== "INTERNAL"))(
    "keeps the code, message and data of a %s error",
    (code) => {
      const data = SAMPLE_DATA[code];
      const wire = toWire(new QuickdrawError(code, `failed with ${code}`, data));
      expect(wire).toEqual(
        data === undefined
          ? { code, message: `failed with ${code}` }
          : { code, message: `failed with ${code}`, data },
      );
    },
  );

  it("omits data rather than sending it as undefined", () => {
    expect(Object.keys(toWire(new QuickdrawError("NOT_FOUND", "Gone")))).toEqual([
      "code",
      "message",
    ]);
  });

  it("sends an INTERNAL error with the generic message only, never its own message or data", () => {
    const error = new QuickdrawError("INTERNAL", "connection to db-7 refused", { host: "db-7" });
    expect(toWire(error)).toEqual({ code: "INTERNAL", message: INTERNAL_MESSAGE });
  });

  it.each([
    ["an Error", new Error("SELECT * FROM users failed: password=hunter2")],
    ["a TypeError", new TypeError("Cannot read properties of undefined")],
    ["a string", "boom"],
    ["undefined", undefined],
    ["null", null],
    ["an object that looks like a wire error", { code: "FORBIDDEN", message: "spoofed" }],
  ])("turns %s into a generic INTERNAL error", (_label, thrown) => {
    expect(toWire(thrown)).toEqual({ code: "INTERNAL", message: INTERNAL_MESSAGE });
  });

  it("never carries a stack", () => {
    const wire = toWire(new QuickdrawError("CONFLICT", "Taken", { slug: "a" }));
    expect(JSON.stringify(wire)).not.toContain("at ");
    expect(Object.keys(wire)).toEqual(["code", "message", "data"]);
  });

  it("treats a QuickdrawError with a code outside the table as INTERNAL", () => {
    const error = new QuickdrawError("TEAPOT" as ErrorCode, "short and stout");
    expect(toWire(error)).toEqual({ code: "INTERNAL", message: INTERNAL_MESSAGE });
  });
});

describe("fromWire", () => {
  it.each(RFC_TABLE.filter(([code]) => code !== "INTERNAL"))(
    "round-trips a %s error through JSON with its code, message and data",
    (code) => {
      const original = new QuickdrawError(code, `failed with ${code}`, SAMPLE_DATA[code]);
      const received = fromWire(JSON.parse(JSON.stringify(toWire(original))));
      expect(received).toBeInstanceOf(QuickdrawError);
      expect(received.code).toBe(original.code);
      expect(received.message).toBe(original.message);
      expect(received.data).toEqual(original.data);
    },
  );

  it("round-trips an INTERNAL error as the generic one", () => {
    const received = fromWire(toWire(new QuickdrawError("INTERNAL", "secret")));
    expect(received.code).toBe("INTERNAL");
    expect(received.message).toBe(INTERNAL_MESSAGE);
    expect(received.data).toBeUndefined();
  });

  it("turns a code this version does not know into INTERNAL, keeping the message and data", () => {
    const received = fromWire({ code: "UNAVAILABLE", message: "Try again soon", data: { a: 1 } });
    expect(received.code).toBe("INTERNAL");
    expect(received.message).toBe("Try again soon");
    expect(received.data).toEqual({ a: 1 });
  });

  it.each([
    ["undefined", undefined],
    ["null", null],
    ["a string", "FORBIDDEN"],
    ["an array", ["FORBIDDEN", "No"]],
    ["an object without a message", { code: "FORBIDDEN" }],
    ["an object whose message is not a string", { code: "FORBIDDEN", message: { text: "No" } }],
  ])("turns %s into a generic INTERNAL error", (_label, payload) => {
    const received = fromWire(payload);
    expect(received).toBeInstanceOf(QuickdrawError);
    expect(received.code).toBe("INTERNAL");
    expect(received.message).toBe(INTERNAL_MESSAGE);
    expect(received.data).toBeUndefined();
  });
});
