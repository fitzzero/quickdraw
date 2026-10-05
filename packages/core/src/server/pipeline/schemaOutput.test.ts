// Schema outputs reduced to what their JSON Schema declares (RFC 0003
// section 9, step 8; the final review's item B): what each JSON Schema form
// keeps and drops, that nothing is copied when nothing is dropped, where a
// tiered key is declared, and what the reduction costs a call.

import { describe, expect, it } from "vitest";
import { z } from "zod";
import { z as z3 } from "zod3";
import type { StandardSchemaV1 } from "../../contract/standardSchema";
import type { SchemaOutput } from "../service";
import { compileSchemaOutput } from "./schemaOutput";

function compiled(schema: StandardSchemaV1): SchemaOutput {
  const output = compileSchemaOutput(schema);
  if (output === undefined) {
    throw new Error("the schema has no JSON Schema");
  }
  return output;
}

/** A schema whose JSON Schema is `json`, as a hand-written Standard JSON Schema would give it. */
function jsonSchema(json: Readonly<Record<string, unknown>>): StandardSchemaV1 {
  return {
    "~standard": {
      version: 1,
      vendor: "test",
      validate: (value: unknown) => ({ value }),
      jsonSchema: { input: () => json, output: () => json },
    },
  } as unknown as StandardSchemaV1;
}

const user = z.object({ id: z.string(), name: z.string() });
const row = {
  id: "u1",
  name: "Ada",
  email: "ada@example.com",
  serviceAccess: { userService: "Admin" },
};

describe("objects", () => {
  it("keeps the keys an object declares, at every depth, and drops the rest", () => {
    const output = compiled(z.object({ user, ok: z.boolean() }));
    expect(output.pick({ user: row, ok: true, extra: 1 })).toEqual({
      user: { id: "u1", name: "Ada" },
      ok: true,
    });
  });

  it("returns the value itself when nothing is dropped, and copies only what changed", () => {
    const output = compiled(z.object({ user, tags: z.array(z.string()) }));
    const exact = { user: { id: "u1", name: "Ada" }, tags: ["a"] };
    expect(output.pick(exact)).toBe(exact);
    const tags = ["a"];
    const wide = { user: row, tags };
    const picked = output.pick(wide) as { user: unknown; tags: unknown };
    expect(picked).not.toBe(wide);
    expect(picked.tags).toBe(tags);
    expect(wide.user).toBe(row);
    expect(row).toHaveProperty("email");
  });

  it("keeps every key of a loose object, a record or a bare object, and reduces a catchall's values", () => {
    expect(compiled(z.looseObject({ id: z.string() })).pick(row)).toBe(row);
    expect(compiled(jsonSchema({ type: "object" })).pick(row)).toBe(row);
    expect(
      compiled(z.record(z.string(), user)).pick({ a: row, b: { id: "u2", name: "Bo" } }),
    ).toEqual({
      a: { id: "u1", name: "Ada" },
      b: { id: "u2", name: "Bo" },
    });
    expect(
      compiled(z.object({ id: z.string() }).catchall(user)).pick({ id: "x", one: row }),
    ).toEqual({
      id: "x",
      one: { id: "u1", name: "Ada" },
    });
  });

  it("reads a hand-written JSON Schema: properties without additionalProperties declare the keys", () => {
    const output = compiled(
      jsonSchema({
        type: "object",
        properties: { id: { type: "string" } },
        patternProperties: { "^x-": { type: "object", properties: { a: {} } } },
      }),
    );
    expect(output.pick({ id: "1", "x-one": { a: 1, b: 2 }, other: 3 })).toEqual({
      id: "1",
      "x-one": { a: 1 },
    });
    expect(
      compiled(jsonSchema({ properties: { id: {} }, additionalProperties: true })).pick(row),
    ).toBe(row);
  });

  it("keeps an own __proto__ key as an own key where the schema allows it, and never sets a prototype", () => {
    const value = JSON.parse('{"id":"1","__proto__":{"polluted":true},"drop":1}') as object;
    const picked = compiled(z.looseObject({ id: z.string() })).pick(value);
    expect(picked).toBe(value);
    const reduced = compiled(z.object({ id: z.string() })).pick(value) as Record<string, unknown>;
    expect(Object.keys(reduced)).toEqual(["id"]);
    expect(Object.getPrototypeOf(reduced)).toBe(Object.prototype);
    const kept = compiled(z.record(z.string(), z.unknown())).pick({
      ...JSON.parse('{"__proto__":1}'),
      drop: undefined,
    });
    expect(kept).toEqual({ ["__proto__"]: 1, drop: undefined });
  });
});

describe("arrays and unions", () => {
  it("reduces each item of an array, and a tuple's items by position", () => {
    expect(compiled(z.array(user)).pick([row, row])).toEqual([
      { id: "u1", name: "Ada" },
      { id: "u1", name: "Ada" },
    ]);
    expect(compiled(z.tuple([z.string(), user])).pick(["a", row, "extra"])).toEqual([
      "a",
      { id: "u1", name: "Ada" },
    ]);
    expect(compiled(z.tuple([z.string()], user)).pick(["a", row, row])).toEqual([
      "a",
      { id: "u1", name: "Ada" },
      { id: "u1", name: "Ada" },
    ]);
  });

  it("keeps a key any branch of a union declares, through null and nested unions", () => {
    const output = compiled(
      z.union([
        z.object({ kind: z.literal("user"), user }),
        z.object({ kind: z.literal("error"), error: z.string() }),
      ]),
    );
    expect(output.pick({ kind: "user", user: row, error: undefined, debug: 1 })).toEqual({
      kind: "user",
      user: { id: "u1", name: "Ada" },
      error: undefined,
    });
    expect(compiled(user.nullable()).pick(null)).toBeNull();
    expect(compiled(user.nullable()).pick(row)).toEqual({ id: "u1", name: "Ada" });
    expect(
      compiled(
        z.union([
          z.object({ a: z.object({ x: z.string() }) }),
          z.object({ a: z.object({ y: z.string() }) }),
        ]),
      ).pick({
        a: { x: "1", y: "2", z: "3" },
      }),
    ).toEqual({ a: { x: "1", y: "2" } });
  });

  it("follows a recursive schema, and keeps everything z.json() allows", () => {
    interface Tree {
      readonly name: string;
      readonly children: readonly Tree[];
    }
    const tree: z.ZodType<Tree> = z.lazy(() =>
      z.object({ name: z.string(), children: z.array(tree) }),
    );
    expect(
      compiled(tree).pick({
        name: "a",
        secret: 1,
        children: [{ name: "b", secret: 2, children: [] }],
      }),
    ).toEqual({ name: "a", children: [{ name: "b", children: [] }] });
    const json = { a: [1, { b: null }], c: { d: "e" } };
    expect(compiled(z.json()).pick(json)).toBe(json);
  });
});

describe("values JSON Schema does not reduce", () => {
  it("keeps any value where the schema allows any, and a Date or a class instance as it is", () => {
    expect(compiled(z.unknown()).pick(row)).toBe(row);
    const at = new Date(0);
    class Money {
      constructor(readonly cents: number) {}
    }
    const money = new Money(5);
    const picked = compiled(z.object({ at: z.date(), money: z.custom<Money>() })).pick({
      at,
      money,
      x: 1,
    });
    expect(picked).toEqual({ at, money });
    expect((picked as { at: unknown }).at).toBe(at);
    expect((picked as { money: unknown }).money).toBe(money);
  });

  it("keeps no key of a plain object where the schema declares a scalar", () => {
    expect(compiled(z.object({ owner: z.string() })).pick({ owner: row })).toEqual({ owner: {} });
    expect(compiled(z.string()).pick([row, "a"])).toEqual([{}, "a"]);
  });

  it("cannot compile a schema without JSON Schema: Zod 3", () => {
    expect(
      compileSchemaOutput(z3.object({ id: z3.string() }) as unknown as StandardSchemaV1),
    ).toBeUndefined();
  });
});

describe("key paths", () => {
  it("names where a schema declares each key, at any depth, the shortest path first", () => {
    const output = compiled(
      z.object({
        email: z.string(),
        user: z.object({ id: z.string(), email: z.string(), phone: z.string() }),
        rows: z.array(z.object({ notes: z.string() })),
        byId: z.record(z.string(), z.object({ secret: z.string() })),
      }),
    );
    const paths = output.keyPaths();
    expect(paths.get("email")).toBe("email");
    expect(paths.get("phone")).toBe("user.phone");
    expect(paths.get("notes")).toBe("rows[].notes");
    expect(paths.get("secret")).toBe("byId{}.secret");
    expect(output.keyPaths()).toBe(paths);
  });
});

describe("cost", () => {
  it("reduces a page of rows in about the time JSON.stringify takes to write it", () => {
    const item = z.object({
      id: z.string(),
      title: z.string(),
      status: z.string(),
      ordinal: z.number(),
      assigneeId: z.string().nullable(),
      labels: z.array(z.object({ id: z.string(), name: z.string() })),
    });
    const output = compiled(z.object({ items: z.array(item), nextCursor: z.string().nullable() }));
    const rows = Array.from({ length: 200 }, (_, index) => ({
      id: `task-${index}`,
      title: `Task number ${index}`,
      status: index % 2 === 0 ? "open" : "done",
      ordinal: index,
      assigneeId: null,
      labels: [{ id: `l${index}`, name: "bug" }],
    }));
    const exact = { items: rows, nextCursor: "c" };
    const wide = {
      items: rows.map((r) => ({ ...r, notes: "secret", createdAt: "2026-01-01T00:00:00.000Z" })),
      nextCursor: "c",
    };
    // The fastest of five batches, after a warm-up: what the code costs, not what the machine did meanwhile.
    const time = (fn: () => unknown): number => {
      for (let round = 0; round < 300; round += 1) {
        fn();
      }
      let best = Number.POSITIVE_INFINITY;
      for (let batch = 0; batch < 5; batch += 1) {
        const start = performance.now();
        for (let round = 0; round < 100; round += 1) {
          fn();
        }
        best = Math.min(best, (performance.now() - start) / 100);
      }
      return best;
    };
    const exactMs = time(() => output.pick(exact));
    const wideMs = time(() => output.pick(wide));
    const stringifyMs = time(() => JSON.stringify(exact));
    // eslint-disable-next-line no-console
    console.info(
      `schema output reduction, 200 rows of 6 keys: ${(exactMs * 1000).toFixed(1)} µs exact, ` +
        `${(wideMs * 1000).toFixed(1)} µs with 2 keys dropped per row; JSON.stringify ${(stringifyMs * 1000).toFixed(1)} µs`,
    );
    expect(output.pick(exact)).toBe(exact);
    // Bounds loose enough for any machine; a schema read per call would cost a hundred times more.
    expect(exactMs).toBeLessThan(stringifyMs * 2);
    expect(wideMs).toBeLessThan(stringifyMs * 4);
  });
});
