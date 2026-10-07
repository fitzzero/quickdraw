// The admin kit's contract half (RFC 0003 section 12.4): the entries
// `admin.contract` makes, the inputs and outputs it generates (validation and
// JSON Schema), and the options it refuses.

import { describe, expect, it } from "vitest";
import { z } from "zod";
import {
  admin,
  ADMIN_METHODS,
  defineContract,
  hasJsonSchema,
  mutation,
  validate,
  type StandardSchemaV1,
} from "../../index";
import { adminSpecOf } from "./admin";

const task = z.object({
  id: z.string(),
  projectId: z.string(),
  title: z.string().min(1),
  status: z.enum(["open", "done"]),
  ordinal: z.number().int(),
  details: z.json(),
  createdAt: z.iso.datetime(),
  updatedAt: z.iso.datetime(),
});

const all = admin.contract({ entity: task, filter: ["status"], sort: ["createdAt", "title"] });

/** The issues' paths a schema reports for `value`, or the value it parsed. */
async function check(schema: StandardSchemaV1, value: unknown) {
  const result = await validate(schema, value);
  return result.issues === undefined
    ? { value: result.value }
    : { paths: result.issues.map((issue) => issue.path ?? []) };
}

describe("admin.contract", () => {
  it("makes an ordinary entry for each of the eight methods, or those expose names", () => {
    expect(Object.keys(all)).toEqual([...ADMIN_METHODS]);
    expect(Object.values(all).map((method) => method.kind)).toEqual([
      "query",
      "query",
      "mutation",
      "mutation",
      "mutation",
      "query",
      "query",
      "mutation",
    ]);
    expect(Object.isFrozen(all)).toBe(true);
    expect(all.adminGet.describe).toBe("Reads one row by id, as a service administrator sees it.");
    const some = admin.contract({
      entity: task,
      expose: ["adminMeta", "adminList"],
      describe: { adminList: "Lists tasks." },
    });
    expect(Object.keys(some)).toEqual(["adminMeta", "adminList"]);
    expect(some.adminList.describe).toBe("Lists tasks.");
  });

  it("spreads into a contract beside hand-written methods, and marks only its own", () => {
    const contract = defineContract("taskService", {
      entity: task,
      methods: {
        ...all,
        rename: mutation({
          input: z.object({ id: z.string(), title: z.string() }),
          output: "entity",
        }),
      },
    });
    expect(adminSpecOf(contract.methods.adminList)).toMatchObject({
      method: "adminList",
      entity: task,
      filter: ["status"],
      sort: ["createdAt", "title"],
    });
    expect(adminSpecOf(contract.methods.adminMeta)?.fields.map((field) => field.name)).toEqual(
      Object.keys(task.shape),
    );
    expect(adminSpecOf(contract.methods.rename)).toBeUndefined();
    expect(adminSpecOf(undefined)).toBeUndefined();
  });

  it("refuses options it does not know, and malformed ones", () => {
    const bad = (options: unknown) => () => admin.contract(options as never);
    expect(bad({ entity: task, where: true })).toThrow('admin.contract: unknown option "where"');
    expect(bad({ filter: ["status"] })).toThrow("entity must be the contract's entity schema");
    expect(bad({ entity: task, filter: ["nope"] })).toThrow(
      'filter: "nope" is not a field of the entity holding strings, numbers or booleans',
    );
    expect(bad({ entity: task, sort: ["details"] })).toThrow(
      'sort: "details" is not a field of the entity holding strings, numbers or booleans',
    );
    expect(bad({ entity: task, sort: ["title", "title"] })).toThrow(
      "sort must be a list of distinct field names",
    );
    expect(bad({ entity: task, expose: ["adminPurge"] })).toThrow(
      "expose must name one or more distinct admin methods",
    );
    expect(bad({ entity: task, expose: [] })).toThrow("expose must name one or more");
    expect(bad({ entity: task, expose: ["adminGet"], describe: { adminList: "x" } })).toThrow(
      'describe names "adminList", which these options do not add',
    );
    expect(bad({ entity: z.object({ title: z.string() }) })).toThrow(
      "the entity schema must describe an object with an id",
    );
  });
});

describe("adminList's input", () => {
  const input = all.adminList.input;

  it("defaults to page 1 of 20, clamps a page at 100, and fills the sort's direction", async () => {
    expect(await check(input, undefined)).toEqual({
      value: { page: 1, pageSize: 20, filter: {}, sort: undefined },
    });
    expect(
      await check(input, {
        page: 3,
        pageSize: 500,
        sort: { field: "title" },
        filter: { status: "done" },
      }),
    ).toEqual({
      value: {
        page: 3,
        pageSize: 100,
        filter: { status: "done" },
        sort: { field: "title", direction: "asc" },
      },
    });
  });

  it("refuses undeclared fields, operators, where and orderBy, and bad pages", async () => {
    expect(
      await check(input, {
        filter: { title: "x", status: { in: ["open"] } },
        sort: { field: "ordinal" },
        where: {},
        orderBy: {},
        page: 0,
        pageSize: 2.5,
      }),
    ).toEqual({
      paths: [
        ["where"],
        ["orderBy"],
        ["filter", "title"],
        ["filter", "status"],
        ["sort", "field"],
        ["page"],
        ["pageSize"],
      ],
    });
    expect(await check(input, { page: 1_000_001 })).toEqual({ paths: [["page"]] });
  });

  it("describes itself as JSON Schema from the declared fields", () => {
    expect(hasJsonSchema(input)).toBe(true);
    const json = (
      input as unknown as { "~standard": { jsonSchema: { input: (o: object) => unknown } } }
    )["~standard"].jsonSchema.input({ target: "draft-07" });
    expect(json).toMatchObject({
      type: "object",
      properties: {
        filter: { properties: { status: { type: "string", enum: ["open", "done"] } } },
        sort: { properties: { field: { enum: ["createdAt", "title"] } } },
        page: { type: "integer", minimum: 1, default: 1 },
        pageSize: { type: "integer", maximum: 100, default: 20 },
      },
    });
  });
});

describe("the writes' input", () => {
  it("takes the entity's fields but id and the timestamps, each checked by the entity schema", async () => {
    const create = all.adminCreate.input;
    expect(
      await check(create, { data: { title: "New", status: "open", ordinal: undefined } }),
    ).toEqual({ value: { data: { title: "New", status: "open" } } });
    expect(
      await check(create, {
        data: { id: "x", createdAt: "2026-01-01T00:00:00.000Z", nope: 1 },
      }),
    ).toEqual({
      paths: [
        ["data", "id"],
        ["data", "createdAt"],
        ["data", "nope"],
      ],
    });
    expect(
      await check(create, {
        data: { title: "", status: "late", ordinal: 1.5, details: { a: [1] } },
      }),
    ).toEqual({
      paths: [
        ["data", "title"],
        ["data", "status"],
        ["data", "ordinal"],
      ],
    });
    expect(await check(create, {})).toEqual({ paths: [["data"]] });
    const update = all.adminUpdate.input;
    expect(await check(update, { id: "t1", data: { details: null } })).toEqual({
      value: { id: "t1", data: { details: null } },
    });
    expect(await check(update, { data: {} })).toEqual({ paths: [["id"]] });
  });

  it("takes only the fields editable names (finding R1.4), in its checks and its JSON Schema", async () => {
    const kit = admin.contract({ entity: task, editable: ["title", "status"] });
    const inputs = [
      [kit.adminCreate.input, {}],
      [kit.adminUpdate.input, { id: "t1" }],
    ] as const;
    for (const [input, key] of inputs) {
      expect(await check(input, { ...key, data: { title: "New", status: "done" } })).toEqual({
        value: { ...key, data: { title: "New", status: "done" } },
      });
      const refused = await validate(input, { ...key, data: { title: "New", ordinal: 2 } });
      expect(refused.issues).toEqual([
        {
          message: '"ordinal" is not a writable field; the writable fields are "title", "status"',
          path: ["data", "ordinal"],
        },
      ]);
      const json = (
        input as unknown as { "~standard": { jsonSchema: { input: (o: object) => unknown } } }
      )["~standard"].jsonSchema.input({ target: "draft-07" }) as {
        readonly properties: { readonly data: { readonly properties: object } };
      };
      expect(Object.keys(json.properties.data.properties)).toEqual(["title", "status"]);
    }
    expect(adminSpecOf(kit.adminUpdate)?.editable).toEqual(["title", "status"]);
    expect(adminSpecOf(all.adminUpdate)?.editable).toBeUndefined();
  });

  it("refuses an editable list that names no writable field of the entity", () => {
    const bad = (editable: unknown) => () =>
      admin.contract({ entity: task, editable: editable as never });
    expect(bad(["nope"])).toThrow('admin.contract: editable: "nope" is not a field of the entity');
    expect(bad(["createdAt"])).toThrow(
      'admin.contract: editable: "createdAt" is never editable; the database sets it',
    );
    expect(bad(["id"])).toThrow('editable: "id" is never editable');
    expect(bad(["title", "title"])).toThrow("editable must be a list of distinct field names");
    expect(bad("title")).toThrow("editable must be a list of distinct field names");
  });
});

describe("the outputs", () => {
  it("check a row for an id, a page for its counts, and adminMeta's and the subscribers' shapes", async () => {
    expect(await check(all.adminGet.output as StandardSchemaV1, { id: "t1" })).toEqual({
      value: { id: "t1" },
    });
    expect(await check(all.adminGet.output as StandardSchemaV1, { title: "x" })).toEqual({
      paths: [[]],
    });
    expect(
      await check(all.adminList.output as StandardSchemaV1, {
        items: [{ id: "t1" }],
        total: 1,
        page: 1,
        pageSize: 20,
        totalPages: 1,
      }),
    ).toMatchObject({ value: { total: 1 } });
    expect(
      await check(all.adminList.output as StandardSchemaV1, {
        items: [{}],
        total: -1,
        page: 0,
        pageSize: 20,
        totalPages: 1,
      }),
    ).toEqual({ paths: [["items", 0], ["total"], ["page"]] });
    expect(
      await check(all.adminSubscribers.output as StandardSchemaV1, {
        id: "t1",
        count: 1,
        levels: { Read: 1, Moderate: 0, Admin: 0 },
        complete: true,
      }),
    ).toMatchObject({ value: { count: 1 } });
    expect(await check(all.adminMeta.input, undefined)).toEqual({ value: undefined });
    expect(await check(all.adminMeta.input, {})).toEqual({ value: undefined });
    expect(await check(all.adminMeta.input, { x: 1 })).toEqual({ paths: [["x"]] });
  });
});
