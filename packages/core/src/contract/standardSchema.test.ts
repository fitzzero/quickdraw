/* oxlint-disable quickdraw/no-todo-schema -- these tests are about todoSchema itself */
import { describe, expect, expectTypeOf, it } from "vitest";
import { z } from "zod";
import { z as z3 } from "zod3";
import {
  hasJsonSchema,
  type InferInput,
  type InferOutput,
  isStandardSchema,
  type StandardSchemaV1,
  TODO_SCHEMA_VENDOR,
  todoSchema,
  validate,
} from "./standardSchema";

/** A hand-written schema, as a library other than Zod would provide. */
const evenNumber: StandardSchemaV1<number> = {
  "~standard": {
    version: 1,
    vendor: "test",
    validate: (value) =>
      typeof value === "number" && value % 2 === 0
        ? { value }
        : { issues: [{ message: "must be even", path: [{ key: "n" }] }] },
  },
};

describe("validate", () => {
  it("returns the parsed value from a Zod 4 schema", async () => {
    const schema = z.object({ id: z.string(), days: z.number().default(30) });
    expect(await validate(schema, { id: "t1" })).toEqual({ value: { id: "t1", days: 30 } });
  });

  it("returns the parsed value from a Zod 3.25 schema", async () => {
    const schema = z3.object({ id: z3.string() }).strict();
    expect(await validate(schema, { id: "t1" })).toEqual({ value: { id: "t1" } });
  });

  it("returns issues with their paths when the value is invalid", async () => {
    const result = await validate(z3.object({ id: z3.string() }), { id: 1 });
    expect(result.issues).toHaveLength(1);
    expect(result.issues?.[0]?.path).toEqual(["id"]);
  });

  it("awaits a schema that validates asynchronously", async () => {
    const schema = z.string().refine(async (value) => value.length > 1, "too short");
    expect(schema["~standard"].validate("ab")).toBeInstanceOf(Promise);
    expect(await validate(schema, "ab")).toEqual({ value: "ab" });
    expect((await validate(schema, "a")).issues?.[0]?.message).toBe("too short");
  });

  it("accepts any library's schema, synchronous results included", async () => {
    expect(await validate(evenNumber, 4)).toEqual({ value: 4 });
    expect(await validate(evenNumber, 3)).toEqual({
      issues: [{ message: "must be even", path: [{ key: "n" }] }],
    });
  });
});

describe("isStandardSchema", () => {
  it("recognizes Zod 3, Zod 4 and hand-written schemas", () => {
    expect(isStandardSchema(z.string())).toBe(true);
    expect(isStandardSchema(z3.string())).toBe(true);
    expect(isStandardSchema(evenNumber)).toBe(true);
  });

  it("rejects values that only look like schemas", () => {
    expect(isStandardSchema(undefined)).toBe(false);
    expect(isStandardSchema("entity")).toBe(false);
    expect(isStandardSchema({ "~standard": { version: 2, validate: () => ({}) } })).toBe(false);
    expect(isStandardSchema({ "~standard": { version: 1 } })).toBe(false);
  });
});

describe("hasJsonSchema", () => {
  it("is true for Zod 4, which implements Standard JSON Schema", () => {
    const schema = z.object({ id: z.string() });
    expect(hasJsonSchema(schema)).toBe(true);
    if (hasJsonSchema(schema)) {
      const json = schema["~standard"].jsonSchema.input({ target: "draft-2020-12" });
      expect(json).toMatchObject({ type: "object", required: ["id"] });
    }
  });

  it("is false for schemas without it", () => {
    expect(hasJsonSchema(z3.object({ id: z3.string() }))).toBe(false);
    expect(hasJsonSchema(evenNumber)).toBe(false);
  });
});

describe("todoSchema", () => {
  interface ProjectDTO {
    id: string;
    name: string;
    archived: boolean;
  }

  it("passes every value through unchanged and synchronously, as an unvalidated 4.x payload did", async () => {
    const schema = todoSchema<ProjectDTO>();
    const value = { id: "p1", name: "Board", extra: [1, 2] };
    expect(schema["~standard"].validate(value)).toEqual({ value });
    expect(schema["~standard"].validate(value)).not.toBeInstanceOf(Promise);
    expect(await validate(schema, null)).toEqual({ value: null });
    expect(await validate(schema, "anything")).toEqual({ value: "anything" });
  });

  it("is a Standard Schema with a permissive JSON Schema, and says it is a placeholder", () => {
    const schema = todoSchema<ProjectDTO>();
    expect(isStandardSchema(schema)).toBe(true);
    expect(hasJsonSchema(schema)).toBe(true);
    expect(schema["~standard"].vendor).toBe(TODO_SCHEMA_VENDOR);
    expect(schema["~standard"].jsonSchema.input({ target: "draft-07" })).toEqual({
      type: "object",
    });
    expect(schema["~standard"].jsonSchema.output({ target: "draft-2020-12" })).toEqual({
      type: "object",
    });
  });

  it("lists its keys as JSON Schema properties, each accepting any value", () => {
    const schema = todoSchema<ProjectDTO>({ keys: ["id", "name"] });
    expect(schema["~standard"].jsonSchema.output({ target: "draft-07" })).toEqual({
      type: "object",
      properties: { id: {}, name: {} },
    });
  });

  it("types its value as T, and its keys as T's keys", () => {
    const schema = todoSchema<ProjectDTO>({ keys: ["id"] });
    expectTypeOf<InferInput<typeof schema>>().toEqualTypeOf<ProjectDTO>();
    expectTypeOf<InferOutput<typeof schema>>().toEqualTypeOf<ProjectDTO>();
    // @ts-expect-error -- "title" is not a key of ProjectDTO
    todoSchema<ProjectDTO>({ keys: ["title"] });
  });
});
