// The read/write kit's contract half (RFC 0003 section 12.1): the entries
// `crud.contract` makes, the inputs and outputs it generates (validation and
// JSON Schema), and the options it refuses.

import { describe, expect, it } from "vitest";
import { z } from "zod";
import {
  crud,
  defineContract,
  hasJsonSchema,
  mutation,
  validate,
  type StandardSchemaV1,
} from "../../index";
import { crudSpecOf } from "./crud";

const task = z.object({
  id: z.string(),
  projectId: z.string(),
  title: z.string(),
  status: z.enum(["open", "done"]),
  ordinal: z.number(),
  assigneeId: z.string().nullable(),
});
const card = task.pick({ id: true, title: true, ordinal: true });
const patch = z.object({ title: z.string().min(1), status: z.enum(["open", "done"]) }).partial();

const all = crud.contract({
  entity: task,
  get: true,
  getMany: { describe: "Reads tasks." },
  list: { item: card, filter: ["projectId", "status"], sort: ["ordinal", "title"] },
  create: { input: task.omit({ id: true, ordinal: true }) },
  update: { input: patch },
  delete: true,
  reorder: { column: "ordinal", within: "projectId" },
  bulkUpdate: { input: patch },
  bulkDelete: true,
});

/** The issues' paths a schema reports for `value`, or the value it parsed. */
async function check(schema: StandardSchemaV1, value: unknown) {
  const result = await validate(schema, value);
  return result.issues === undefined
    ? { value: result.value }
    : { paths: result.issues.map((issue) => issue.path ?? []) };
}

describe("crud.contract", () => {
  it("makes an ordinary entry for each method named, and nothing else", () => {
    expect(Object.keys(all)).toEqual([
      "get",
      "getMany",
      "list",
      "create",
      "update",
      "delete",
      "reorder",
      "bulkUpdate",
      "bulkDelete",
    ]);
    expect(Object.values(all).map((method) => method.kind)).toEqual([
      "query",
      "query",
      "query",
      "mutation",
      "mutation",
      "mutation",
      "mutation",
      "mutation",
      "mutation",
    ]);
    expect(all.get.output).toBe("entity");
    expect(all.getMany.output).toEqual({ kind: "list", projection: "entity" });
    expect(all.reorder.output).toBe("entity");
    expect(all.getMany.describe).toBe("Reads tasks.");
    expect(all.get.describe).toBe("Reads one row by id.");
    expect(Object.isFrozen(all)).toBe(true);
    expect(
      Object.keys(crud.contract({ entity: task, get: true, list: undefined, delete: false })),
    ).toEqual(["get"]);
  });

  it("spreads into a contract beside hand-written methods, and marks only its own", () => {
    const contract = defineContract("taskService", {
      entity: task,
      projections: { card },
      methods: {
        ...all,
        rename: mutation({
          input: z.object({ id: z.string(), title: z.string() }),
          output: "entity",
        }),
      },
    });
    expect(crudSpecOf(contract.methods.list)).toEqual({
      method: "list",
      filter: ["projectId", "status"],
      sort: ["ordinal", "title"],
      item: card,
    });
    expect(crudSpecOf(contract.methods.reorder)).toEqual({
      method: "reorder",
      column: "ordinal",
      within: ["projectId"],
    });
    expect(crudSpecOf(contract.methods.get)).toEqual({ method: "get" });
    expect(crudSpecOf(contract.methods.rename)).toBeUndefined();
    expect(crudSpecOf(undefined)).toBeUndefined();
  });

  it("refuses options it does not know, and malformed ones", () => {
    const bad = (options: unknown) => () => crud.contract(options as never);
    expect(bad({ entity: task, get: true, search: true })).toThrow(
      'crud.contract: the options has an unknown option "search"',
    );
    expect(bad({ get: true })).toThrow("entity must be the contract's entity schema");
    expect(bad({ entity: task, get: "yes" })).toThrow("get must be true, false or { describe }");
    expect(bad({ entity: task, get: { describe: "" } })).toThrow(
      "describe must be a non-empty string",
    );
    expect(bad({ entity: task, list: { filter: "status" } })).toThrow(
      "list.filter must be a list of distinct field names",
    );
    expect(bad({ entity: task, list: { filter: ["status", "status"] } })).toThrow(
      "list.filter must be a list of distinct field names",
    );
    expect(bad({ entity: task, list: { where: {} } })).toThrow(
      'list has an unknown option "where"',
    );
    expect(bad({ entity: task, list: { item: "card" } })).toThrow(
      "list.item must be the entity schema",
    );
    expect(bad({ entity: task, create: {} })).toThrow("create must be { input: <Standard Schema>");
    expect(bad({ entity: task, reorder: { column: "id" } })).toThrow(
      "reorder.column must be a numeric column other than id",
    );
    expect(bad({ entity: task, reorder: { column: "ordinal", within: ["ordinal"] } })).toThrow(
      "reorder.column must be a numeric column other than id and the within columns",
    );
  });
});

describe("the inputs it generates", () => {
  it("checks get's and getMany's ids", async () => {
    expect(await check(all.get.input, { id: "t1" })).toEqual({ value: { id: "t1" } });
    expect(await check(all.get.input, { id: "", extra: 1 })).toEqual({
      paths: [["extra"], ["id"]],
    });
    expect(await check(all.getMany.input, { ids: ["a", 2] })).toEqual({ paths: [["ids", 1]] });
    const many = Array.from({ length: 201 }, (_, index) => `t${index}`);
    expect(await check(all.getMany.input, { ids: many })).toEqual({ paths: [["ids"]] });
    expect(await check(all.getMany.input, { ids: many.slice(1) })).toEqual({
      value: { ids: many.slice(1) },
    });
  });

  it("parses list's input with its defaults, clamping the limit", async () => {
    expect(await check(all.list.input, undefined)).toEqual({
      value: { filter: {}, sort: undefined, cursor: undefined, limit: 50, totalCount: false },
    });
    expect(
      await check(all.list.input, {
        filter: { status: "open", projectId: null },
        sort: { field: "title" },
        limit: 1000,
        totalCount: true,
        cursor: "c",
      }),
    ).toEqual({
      value: {
        filter: { status: "open", projectId: null },
        sort: { field: "title", direction: "asc" },
        cursor: "c",
        limit: 200,
        totalCount: true,
      },
    });
  });

  it("refuses list filters and sorts on undeclared fields, operators as values, and bad paging", async () => {
    expect(
      await check(all.list.input, {
        filter: { title: "x", status: { not: "open" } },
        sort: { field: "assigneeId", direction: "up", nulls: "last" },
        cursor: "",
        limit: 1.5,
        totalCount: "yes",
        where: {},
      }),
    ).toEqual({
      paths: [
        ["where"],
        ["filter", "title"],
        ["filter", "status"],
        ["sort", "nulls"],
        ["sort", "field"],
        ["sort", "direction"],
        ["cursor"],
        ["limit"],
        ["totalCount"],
      ],
    });
    expect(await check(all.list.input, { filter: [] })).toEqual({ paths: [["filter"]] });
    expect(await check(all.list.input, "page 2")).toEqual({ paths: [[]] });
  });

  it("adds id to update's patch, and ids to bulkUpdate's, checking the patch with the app's schema", async () => {
    expect(await check(all.update.input, { id: "t1", title: "New" })).toEqual({
      value: { id: "t1", title: "New" },
    });
    expect(await check(all.update.input, { id: "t1" })).toEqual({ value: { id: "t1" } });
    expect(await check(all.update.input, { title: "", status: "late" })).toEqual({
      paths: [["id"], ["title"], ["status"]],
    });
    expect(await check(all.bulkUpdate.input, { ids: ["a"], data: { status: "done" } })).toEqual({
      value: { ids: ["a"], data: { status: "done" } },
    });
    expect(await check(all.bulkUpdate.input, { ids: "a", data: { status: "late" }, x: 1 })).toEqual(
      { paths: [["x"], ["ids"], ["data", "status"]] },
    );
  });

  it("checks reorder's neighbors", async () => {
    expect(await check(all.reorder.input, { id: "a", beforeId: "b" })).toEqual({
      value: { id: "a", beforeId: "b" },
    });
    expect(await check(all.reorder.input, { id: "a" })).toEqual({ paths: [[]] });
    expect(await check(all.reorder.input, { id: "a", beforeId: "a", afterId: 3 })).toEqual({
      paths: [["beforeId"], ["afterId"]],
    });
    expect(await check(all.reorder.input, { id: "a", beforeId: "b", afterId: "b" })).toEqual({
      paths: [["afterId"]],
    });
  });

  it("checks the outputs: a page of rows, null and a count", async () => {
    const page = all.list.output;
    expect(await check(page, { items: [{ id: "t1", title: "T" }], nextCursor: null })).toEqual({
      value: { items: [{ id: "t1", title: "T" }], nextCursor: null },
    });
    expect(await check(page, { items: [{ title: "T" }], nextCursor: 3, totalCount: -1 })).toEqual({
      paths: [["items", 0], ["nextCursor"], ["totalCount"]],
    });
    expect(await check(all.delete.output, null)).toEqual({ value: null });
    expect(await check(all.bulkDelete.output, { count: 2 })).toEqual({ value: { count: 2 } });
    expect(await check(all.bulkDelete.output, { count: -1 })).toEqual({ paths: [[]] });
  });
});

describe("their JSON Schema", () => {
  const json = (schema: StandardSchemaV1, target = "draft-07") => {
    if (!hasJsonSchema(schema)) {
      throw new Error("no JSON Schema");
    }
    return schema["~standard"].jsonSchema.input({ target });
  };

  it("describes every generated input, for MCP tools", () => {
    for (const method of Object.values(all)) {
      expect(hasJsonSchema(method.input)).toBe(true);
    }
    expect(json(all.get.input)).toEqual({
      $schema: "http://json-schema.org/draft-07/schema#",
      type: "object",
      properties: { id: { type: "string", minLength: 1 } },
      required: ["id"],
      additionalProperties: false,
    });
    expect(json(all.getMany.input, "draft-2020-12")).toMatchObject({
      $schema: "https://json-schema.org/draft/2020-12/schema",
      properties: { ids: { type: "array", maxItems: 200 } },
    });
    expect(() => json(all.get.input, "openapi-3.0")).toThrow("not openapi-3.0");
  });

  it("takes list's filter fields from the entity, and lists the sort fields", () => {
    expect(json(all.list.input)).toMatchObject({
      type: "object",
      additionalProperties: false,
      properties: {
        filter: {
          type: "object",
          properties: { projectId: { type: "string" }, status: { enum: ["open", "done"] } },
          additionalProperties: false,
        },
        sort: { properties: { field: { enum: ["ordinal", "title"] } }, required: ["field"] },
        limit: { type: "integer", minimum: 1, maximum: 200, default: 50 },
      },
    });
  });

  it("writes update's from the app's patch with id added, and none when the patch has none", async () => {
    expect(json(all.update.input)).toMatchObject({
      type: "object",
      properties: { id: { type: "string" }, title: { type: "string" }, status: {} },
      required: ["id"],
    });
    const plain: StandardSchemaV1<{ title?: string }> = {
      "~standard": {
        version: 1,
        vendor: "test",
        validate: (value) => ({ value: value as { title?: string } }),
      },
    };
    const kit = crud.contract({
      entity: task,
      update: { input: plain },
      bulkUpdate: { input: plain },
    });
    expect(hasJsonSchema(kit.update.input)).toBe(false);
    expect(hasJsonSchema(kit.bulkUpdate.input)).toBe(false);
    expect(await check(kit.update.input, { id: "t1", title: "x" })).toEqual({
      value: { id: "t1", title: "x" },
    });
  });
});
