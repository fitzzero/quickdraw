// The search kit's contract half (RFC 0003 section 12.2): the entry
// `search.contract` makes, the input and output it generates (validation and
// JSON Schema), and the options it refuses.

import { describe, expect, it } from "vitest";
import { z } from "zod";
import {
  defineContract,
  hasJsonSchema,
  search,
  validate,
  type StandardSchemaV1,
} from "../../index";
import { searchSpecOf } from "./search";

const task = z.object({
  id: z.string(),
  projectId: z.string(),
  title: z.string(),
  notes: z.string().nullable(),
  ordinal: z.number(),
});
const card = task.pick({ id: true, projectId: true, title: true });

const scoped = search.contract({ entity: task, item: card, fields: ["title"], scope: "byProject" });
const plain = search.contract({ entity: task, fields: ["title", "notes"], minLength: 3 });

/** The issues' paths a schema reports for `value`, or the value it parsed. */
async function check(schema: StandardSchemaV1, value: unknown) {
  const result = await validate(schema, value);
  return result.issues === undefined
    ? { value: result.value }
    : { paths: result.issues.map((issue) => issue.path ?? []) };
}

describe("search.contract", () => {
  it("makes one query entry, search, and marks it with what it was made for", () => {
    expect(Object.keys(scoped)).toEqual(["search"]);
    expect(scoped.search.kind).toBe("query");
    expect(Object.isFrozen(scoped)).toBe(true);
    expect(scoped.search.describe).toContain("Pass scope (one scope of byProject)");
    const contract = defineContract("taskService", {
      entity: task,
      projections: { card },
      methods: { find: scoped.search },
      collections: {
        byProject: { scope: "projectId", item: "card", order: [["id", "asc"]] },
      },
    });
    expect(searchSpecOf(contract.methods.find)).toEqual({
      fields: ["title"],
      item: card,
      scope: "byProject",
      minLength: 2,
    });
    expect(searchSpecOf(plain.search)).toMatchObject({ item: undefined, minLength: 3 });
    expect(searchSpecOf({ kind: "query" })).toBeUndefined();
  });

  it("refuses options it does not know, and malformed ones", () => {
    const bad = (options: unknown) => () => search.contract(options as never);
    expect(bad({ entity: task, fields: ["title"], where: {} })).toThrow(
      'search.contract: unknown option "where"',
    );
    expect(bad({ fields: ["title"] })).toThrow("entity must be the contract's entity schema");
    expect(bad({ entity: task, fields: [] })).toThrow("fields must be a list of the distinct");
    expect(bad({ entity: task, fields: ["title", "title"] })).toThrow("fields must be a list");
    expect(bad({ entity: task, fields: ["title"], item: "card" })).toThrow(
      "item must be the entity schema",
    );
    expect(bad({ entity: task, fields: ["title"], scope: "" })).toThrow(
      "scope must name a collection",
    );
    expect(bad({ entity: task, fields: ["title"], minLength: 0 })).toThrow(
      "minLength must be a whole number from 1 to 256",
    );
    expect(bad({ entity: task, fields: ["title"], describe: "" })).toThrow(
      "describe must be a non-empty string",
    );
  });
});

describe("its input", () => {
  it("trims q and applies the defaults, clamping the limit", async () => {
    expect(await check(scoped.search.input, { q: "  plan  " })).toEqual({
      value: { q: "plan", scope: undefined, cursor: undefined, limit: 20 },
    });
    expect(
      await check(scoped.search.input, { q: "plan", scope: "p1", cursor: "c", limit: 500 }),
    ).toEqual({ value: { q: "plan", scope: "p1", cursor: "c", limit: 100 } });
  });

  it("refuses a missing or long q, a scope it does not keep to, and bad paging", async () => {
    expect(await check(scoped.search.input, undefined)).toEqual({ paths: [[]] });
    expect(
      await check(scoped.search.input, { q: 1, scope: 2, cursor: "", limit: 1.5, x: true }),
    ).toEqual({ paths: [["x"], ["q"], ["scope"], ["cursor"], ["limit"]] });
    expect(await check(scoped.search.input, { q: "x".repeat(257) })).toEqual({ paths: [["q"]] });
    // A search without a scope collection takes no scope.
    expect(await check(plain.search.input, { q: "plan", scope: "p1" })).toEqual({
      paths: [["scope"]],
    });
  });

  it("describes itself as JSON Schema, for MCP tools", () => {
    const json = (schema: StandardSchemaV1) => {
      if (!hasJsonSchema(schema)) {
        throw new Error("no JSON Schema");
      }
      return schema["~standard"].jsonSchema.input({ target: "draft-07" });
    };
    expect(json(scoped.search.input)).toMatchObject({
      type: "object",
      required: ["q"],
      additionalProperties: false,
      properties: {
        q: { type: "string", maxLength: 256 },
        scope: { type: "string" },
        limit: { type: "integer", minimum: 1, maximum: 100, default: 20 },
      },
    });
    expect(json(plain.search.input)).not.toHaveProperty("properties.scope");
    expect(json(scoped.search.output)).toMatchObject({
      required: ["items", "nextCursor"],
      properties: { items: { type: "array", items: { type: "object" } }, rev: { type: "number" } },
    });
  });
});

describe("its output", () => {
  it("is a page of rows with an id, a cursor and maybe a revision", async () => {
    const page = scoped.search.output;
    expect(await check(page, { items: [{ id: "t1" }], nextCursor: null, rev: 5 })).toEqual({
      value: { items: [{ id: "t1" }], nextCursor: null, rev: 5 },
    });
    expect(await check(page, { items: [{}], nextCursor: 1, rev: "5", totalCount: 1 })).toEqual({
      paths: [["totalCount"], ["items", 0], ["nextCursor"], ["rev"]],
    });
  });
});
