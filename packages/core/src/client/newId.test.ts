// `newId()` (finding F11.2): a version 4 UUID from `crypto.randomUUID()`, or
// made from `crypto.getRandomValues()` where a page over plain http has no
// `randomUUID`.

import { afterEach, describe, expect, it, vi } from "vitest";
import { newId } from "./newId";

/** A version 4 UUID: the version nibble 4, the variant bits binary 10. */
const V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

const real = globalThis.crypto;

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("newId", () => {
  it("is a version 4 UUID from crypto.randomUUID where the runtime has it, new each time", () => {
    const randomUUID = vi.spyOn(real, "randomUUID");
    try {
      const ids = Array.from({ length: 100 }, () => newId());
      expect(randomUUID).toHaveBeenCalledTimes(100);
      expect(ids.every((id) => V4.test(id))).toBe(true);
      expect(new Set(ids).size).toBe(100);
    } finally {
      randomUUID.mockRestore();
    }
  });

  it("makes one from crypto.getRandomValues where randomUUID is missing (a page over plain http)", () => {
    const getRandomValues = vi.fn((array: Uint8Array<ArrayBuffer>) => real.getRandomValues(array));
    vi.stubGlobal("crypto", { getRandomValues });
    const ids = Array.from({ length: 100 }, () => newId());
    expect(getRandomValues).toHaveBeenCalledTimes(100);
    expect(ids.every((id) => V4.test(id))).toBe(true);
    expect(new Set(ids).size).toBe(100);
    // The version and the variant are set whatever the bytes are; every other bit is random.
    const filled = (value: number) => (array: Uint8Array) => array.fill(value);
    vi.stubGlobal("crypto", { getRandomValues: filled(0xff) });
    expect(newId()).toBe("ffffffff-ffff-4fff-bfff-ffffffffffff");
    vi.stubGlobal("crypto", { getRandomValues: filled(0) });
    expect(newId()).toBe("00000000-0000-4000-8000-000000000000");
  });

  it("throws in a runtime without Web Crypto", () => {
    vi.stubGlobal("crypto", undefined);
    expect(() => newId()).toThrow(
      new TypeError("newId: this runtime has no crypto.getRandomValues"),
    );
  });
});
