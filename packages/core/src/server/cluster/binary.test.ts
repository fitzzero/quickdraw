// The binary values of a stream push's items across nodes (`binary.ts`),
// through the JSON a server-side event travels as (the Redis adapter's
// `JSON.stringify`, then `JSON.parse` on the receiver): each kind comes back
// as itself, wherever it sat in an item; items without binary, and every
// item of a server that sends JSON only, go as they are; the sender's items
// are never changed; and the receiver puts a value back only over the `null`
// its own parse holds where the path says.

import { describe, expect, it } from "vitest";
import { packItems, registerBinary, unpackItems, type PackedItems } from "./binary";

/** A server that sends binary, and one that sends JSON only. */
const binary = {};
const jsonOnly = {};
registerBinary(binary, true);
registerBinary(jsonOnly, false);

/** The items across one hop: packed, as JSON, parsed, and put back. */
function acrossNodes(io: object, items: readonly unknown[]): unknown[] {
  const wire = JSON.parse(JSON.stringify(packItems(io, items))) as PackedItems & {
    readonly items: unknown[];
  };
  return unpackItems(wire.items, wire.bin);
}

describe("a stream push's binary values across nodes", () => {
  it("come back as their own kind, the same bytes, wherever they sat", () => {
    const items = [
      Buffer.from([1, 2, 3]),
      new Uint8Array([4, 5, 6]),
      new Uint8Array([7, 8, 9]).buffer,
      new Int16Array([-2, 300]),
      new DataView(new Uint8Array([11, 12]).buffer),
      { tick: 1, bytes: Buffer.from([10]), list: [new Uint8Array([13]), "text", null] },
      [new Uint8Array([14])],
      "plain",
      { nothing: "binary" },
    ];
    const back = acrossNodes(binary, items);
    expect(back).toEqual(items);
    expect(Buffer.isBuffer(back[0])).toBe(true);
    expect(back[1]).toBeInstanceOf(Uint8Array);
    expect(Buffer.isBuffer(back[1])).toBe(false);
    expect(back[2]).toBeInstanceOf(ArrayBuffer);
    expect(back[3]).toBeInstanceOf(Int16Array);
    expect([...(back[3] as Int16Array)]).toEqual([-2, 300]);
    expect(back[4]).toBeInstanceOf(DataView);
    expect(Buffer.isBuffer((back[5] as { bytes: unknown }).bytes)).toBe(true);
    expect((back[5] as { list: unknown[] }).list[0]).toBeInstanceOf(Uint8Array);
  });

  it("keep the bytes of a view into a larger buffer only", () => {
    const whole = new Uint8Array([0, 1, 2, 3, 4, 5]);
    const back = acrossNodes(binary, [whole.subarray(2, 4), Buffer.from(whole.buffer, 1, 2)]);
    expect([...(back[0] as Uint8Array)]).toEqual([2, 3]);
    expect([...(back[1] as Buffer)]).toEqual([1, 2]);
  });

  it("leave the sender's items as they are, and send items without binary alone", () => {
    const bytes = Buffer.from([1]);
    const item = { bytes, at: [bytes] };
    const items = [item];
    const packed = packItems(binary, items);
    expect(item).toEqual({ bytes, at: [bytes] });
    expect(item.bytes).toBe(bytes);
    expect(packed.items).not.toBe(items);
    expect(packed.items).toEqual([{ bytes: null, at: [null] }]);
    const plain = [{ n: 1 }, "two", [3]];
    expect(packItems(binary, plain)).toEqual({ items: plain });
    expect(packItems(binary, plain).items).toBe(plain);
  });

  it("go as JSON, walked by nothing, from a server that sends JSON only", () => {
    const items = [Buffer.from([1, 2]), { bytes: new Uint8Array([3]) }];
    const packed = packItems(jsonOnly, items);
    expect(packed).toEqual({ items });
    expect(packed.items).toBe(items);
    expect(acrossNodes(jsonOnly, items)).toEqual([
      { type: "Buffer", data: [1, 2] },
      { bytes: { 0: 3 } },
    ]);
  });

  it("leave a value with its own JSON, and a cycle, to JSON", () => {
    const at = new Date(0);
    expect(acrossNodes(binary, [{ at, bytes: Buffer.from([1]) }])).toEqual([
      { at: at.toJSON(), bytes: Buffer.from([1]) },
    ]);
    const cycle: Record<string, unknown> = { bytes: Buffer.from([2]) };
    cycle.self = cycle;
    expect(() => packItems(binary, [cycle])).not.toThrow();
    expect(() => JSON.stringify(packItems(binary, [cycle]))).toThrow(TypeError);
  });

  it("take nothing for one that looks like a listed value, and put back only over the null left", () => {
    // An app's own values that look like a list or its placeholder are data.
    const items = [{ bin: [[[0], "Buffer", "AQ=="]] }, null, { type: "Buffer", data: [1] }];
    expect(acrossNodes(binary, items)).toEqual(items);
    const parsed = [null, { kept: "x" }, [null]];
    const back = unpackItems(parsed, [
      [[0], "Buffer", "AQ=="],
      [[1, "kept"], "Buffer", "AQ=="],
      [[1, "absent"], "Buffer", "AQ=="],
      [[2, 0], "Uint8Array", "Ag=="],
      [[5], "Buffer", "AQ=="],
      [["__proto__", "polluted"], "Buffer", "AQ=="],
      [[], "Buffer", "AQ=="],
      "not an entry",
      [[0], 1, "AQ=="],
    ]);
    expect(back).toEqual([Buffer.from([1]), { kept: "x" }, [new Uint8Array([2])]]);
    expect(({} as Record<string, unknown>).polluted).toBeUndefined();
    expect(unpackItems(parsed, undefined)).toBe(parsed);
  });

  it("rebuild bytes that do not fill a kind's elements as a Uint8Array", () => {
    expect(unpackItems([null], [[[0], "Int16Array", "AQID"]])).toEqual([new Uint8Array([1, 2, 3])]);
    expect(unpackItems([null], [[[0], "SomeView", "AQ=="]])).toEqual([new Uint8Array([1])]);
  });
});
