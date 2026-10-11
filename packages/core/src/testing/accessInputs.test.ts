// The inputs `snapshotAccessMatrix` makes for a cell (`accessInputs.ts`): the
// cell's row where the method's access form reads it, every other required
// value as small as the input's JSON Schema allows, and nothing when no
// input both passes the schema and names the row.

import { describe, expect, it } from "vitest";
import { z } from "zod";
import { defineContract, mutation, query, todoSchema } from "../index";
import type { StandardSchemaV1 } from "../contract/standardSchema";
import { projectContract, qd } from "../server/access/__tests__/board";
import { custom, owner, type AnyService } from "../server/index";
import { generatedInput, isValidInput, rowServiceOf } from "./accessInputs";

const ROW = "cjld2cjxh0000qzrmn831i7rn";

/** A Standard Schema without JSON Schema, as a Zod 3 schema is: an object with a string `id`. */
const withoutJsonSchema: StandardSchemaV1<{ id: string }> = {
  "~standard": {
    version: 1,
    vendor: "test",
    validate: (value) =>
      typeof value === "object" &&
      value !== null &&
      typeof (value as { readonly id?: unknown }).id === "string"
        ? { value: value as { id: string } }
        : { issues: [{ message: "Expected { id: string }" }] },
  },
};

const contract = defineContract("inputService", {
  entity: z.object({ id: z.string(), title: z.string() }),
  methods: {
    rename: mutation({ input: z.object({ id: z.string(), title: z.string() }), output: "entity" }),
    many: query({ input: z.object({ ids: z.array(z.string()) }), output: z.number() }),
    create: mutation({
      input: z.object({ projectId: z.string(), title: z.string().min(3) }),
      output: "entity",
    }),
    byTask: query({ input: z.object({ note: z.string(), taskId: z.string() }), output: z.null() }),
    bare: query({ input: z.string(), output: z.null() }),
    zod3: query({ input: withoutJsonSchema, output: z.null() }),
    todo: query({ input: todoSchema<{ id: string }>(), output: z.null() }),
    coded: query({
      input: z.object({ id: z.string(), code: z.string().regex(/^[A-Z]{3}-\d{4}$/) }),
      output: z.null(),
    }),
    lookup: query({ input: z.object({ id: z.string() }), output: z.null() }),
    ping: query({ input: z.undefined(), output: z.null() }),
    search: query({
      input: z.object({
        email: z.email(),
        at: z.iso.datetime(),
        uid: z.uuid(),
        ref: z.cuid(),
        page: z.number().int(),
        limit: z.number().int().positive(),
        level: z.enum(["Read", "Admin"]),
        kind: z.literal("task"),
        tags: z.array(z.string()).min(2),
        pair: z.tuple([z.string(), z.boolean()]),
        parent: z.string().nullable(),
        sort: z.string().default("id"),
        filter: z.object({ status: z.string() }).optional(),
        any: z.unknown(),
      }),
      output: z.null(),
    }),
    check: query({ input: z.object({ id: z.string() }), output: z.null() }),
  },
});

const service = qd.defineService(contract, {
  model: "task",
  access: owner("title"),
  methods: {
    rename: { access: { entry: "Moderate" }, handler: () => ({ id: "", title: "" }) },
    many: { access: { entry: "Read", id: "ids" }, handler: () => 0 },
    create: {
      access: { scope: "Moderate", of: projectContract, id: "projectId" },
      handler: () => ({ id: "", title: "" }),
    },
    byTask: { access: { entry: "Read", id: (input) => input.taskId }, handler: () => null },
    bare: { access: { entry: "Read", id: (input: string) => input }, handler: () => null },
    zod3: { access: { entry: "Read" }, handler: () => null },
    todo: { access: { entry: "Read" }, handler: () => null },
    coded: { access: { entry: "Read" }, handler: () => null },
    lookup: { access: "authenticated", rowless: true, handler: () => null },
    ping: { access: "public", handler: () => null },
    search: { access: "authenticated", handler: () => null },
    check: { access: custom(() => true), handler: () => null },
  },
});

function method(name: keyof typeof contract.methods) {
  const found = (service as AnyService).methods[name];
  if (found === undefined) {
    throw new Error(`no method ${name}`);
  }
  return found;
}

async function made(name: keyof typeof contract.methods, row?: string) {
  return (await generatedInput(method(name), row))?.input;
}

describe("generatedInput", () => {
  it("puts the row where an entry form reads it, and fills the other required values", async () => {
    expect(await made("rename", ROW)).toEqual({ id: ROW, title: "x" });
    expect(await made("many", ROW)).toEqual({ ids: [ROW] });
  });

  it("puts a scope form's row at its id key, honoring the other values' bounds", async () => {
    expect(await made("create", ROW)).toEqual({ projectId: ROW, title: "xxx" });
  });

  it("follows a function id selector to the key it reads, or to the input itself", async () => {
    expect(await made("byTask", ROW)).toEqual({ note: "x", taskId: ROW });
    expect(await made("bare", ROW)).toBe(ROW);
  });

  it("puts the row at id without JSON Schema (Zod 3), and for a keyless todoSchema", async () => {
    expect(await made("zod3", ROW)).toEqual({ id: ROW });
    expect(await made("todo", ROW)).toEqual({ id: ROW });
  });

  it("puts the row at id for a form that reads none, when the input has one", async () => {
    expect(await made("lookup", ROW)).toEqual({ id: ROW });
    expect(await made("check", ROW)).toEqual({ id: ROW });
    expect(await made("search", ROW)).not.toHaveProperty("id");
  });

  it("makes no input that passes a pattern it cannot match: the cell is inconclusive", async () => {
    expect(await generatedInput(method("coded"), ROW)).toBeUndefined();
  });

  it("makes the smallest value each JSON Schema keyword allows", async () => {
    expect(await generatedInput(method("ping"), undefined)).toEqual({ input: undefined });
    expect(await made("search")).toEqual({
      email: "snapshot@example.com",
      at: "2026-01-01T00:00:00.000Z",
      uid: "00000000-0000-4000-8000-000000000000",
      ref: "cjld2cjxh0000qzrmn831i7rn",
      page: 0,
      limit: 1,
      level: "Read",
      kind: "task",
      tags: ["x", "x"],
      pair: ["x", false],
      parent: null,
      any: null,
    });
  });
});

describe("rowServiceOf", () => {
  it("names the service whose row each form is about", () => {
    const of = (name: keyof typeof contract.methods) => rowServiceOf(service, method(name));
    expect(of("rename")).toBe("inputService");
    expect(of("create")).toBe("projectService");
    expect(of("lookup")).toBe("inputService");
    expect(of("check")).toBe("inputService");
    expect(of("ping")).toBeUndefined();
    expect(of("search")).toBeUndefined();
  });
});

describe("isValidInput", () => {
  it("checks an input against the method's input schema", async () => {
    expect(await isValidInput(method("rename"), { id: ROW, title: "x" })).toBe(true);
    expect(await isValidInput(method("rename"), { id: ROW })).toBe(false);
  });
});
