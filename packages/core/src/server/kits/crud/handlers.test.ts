// `crud.handlers` (RFC 0003 section 12.1): implementations for exactly the
// kit's methods of a contract, each with its access form, refused when the
// options or the service cannot work, and served as MCP tools like any
// method.

import { describe, expect, it } from "vitest";
import { z } from "zod";
import { crud as contractCrud, defineContract, mutation, QuickdrawError } from "../../../index";
import { projectContract, qd } from "../../emit/__tests__/live";
import { describeTools } from "../../mcp/index";
import { inherit, crud } from "../../index";
import { defineTaskService, taskContract, taskEntity } from "./__tests__/fixture";

const notes = defineContract("noteService", {
  entity: taskEntity,
  methods: {
    ...crud.contract({
      entity: taskEntity,
      get: true,
      create: { input: z.object({ title: z.string() }) },
    }),
    rename: mutation({ input: z.object({ id: z.string(), title: z.string() }), output: "entity" }),
  },
});

describe("crud.handlers", () => {
  it("implements exactly the kit's methods, with the forms given", () => {
    const handlers = crud.handlers(notes, {
      access: { get: { entry: "Read" }, create: "authenticated" },
    });
    expect(Object.keys(handlers)).toEqual(["get", "create"]);
    expect(handlers.get.access).toEqual({ entry: "Read" });
    expect(handlers.create.access).toBe("authenticated");
    expect(typeof handlers.get.handler).toBe("function");
    expect(Object.isFrozen(handlers)).toBe(true);
    // The server's crud carries the contract half too.
    expect(crud.contract).toBe(contractCrud.contract);
  });

  it("follows a kit method the contract renamed", () => {
    const kit = crud.contract({ entity: taskEntity, get: true });
    const renamed = defineContract("renamedService", {
      entity: taskEntity,
      methods: { fetch: kit.get },
    });
    expect(Object.keys(crud.handlers(renamed, { access: { fetch: "authenticated" } }))).toEqual([
      "fetch",
    ]);
  });

  it("refuses access that misses a kit method or names another, and a malformed form", () => {
    const refuse = (options: unknown) => () =>
      crud.handlers(notes, options as Parameters<typeof crud.handlers<typeof notes, never>>[1]);
    expect(refuse({ access: { get: "authenticated" } })).toThrow(
      'crud.handlers: access has no form for "create"',
    );
    expect(
      refuse({ access: { get: "authenticated", create: "authenticated", rename: "public" } }),
    ).toThrow('access names "rename", which is not a method crud.contract made');
    expect(refuse({ access: { get: "everyone", create: "authenticated" } })).toThrow(
      'access for "get" must be "public"',
    );
    expect(refuse({ access: { get: "public", create: "public" }, extra: 1 })).toThrow(
      'options has an unknown key "extra"',
    );
    expect(refuse({ access: { get: "public", create: "public" }, prepare: "owner" })).toThrow(
      "prepare must be a function",
    );
    expect(() => crud.handlers({ name: "x", methods: {} } as never, { access: {} })).toThrow(
      "the first argument must be a contract from defineContract",
    );
  });

  it("refuses prepare for a contract without the kit's create, and a list item no projection has", () => {
    const reads = defineContract("readService", {
      entity: taskEntity,
      methods: { ...crud.contract({ entity: taskEntity, get: true }) },
    });
    expect(() =>
      crud.handlers(reads, {
        access: { get: "public" },
        prepare: (() => ({})) as never,
      }),
    ).toThrow("prepare must be a function, for a contract with the kit's create");
    const stray = z.object({ id: z.string(), title: z.string() });
    const listed = defineContract("listService", {
      entity: taskEntity,
      methods: { ...crud.contract({ entity: taskEntity, list: { item: stray } }) },
    });
    expect(() => crud.handlers(listed, { access: { list: "authenticated" } })).toThrow(
      "list.item of listService must be its entity schema or one of its projections' schemas",
    );
  });
});

describe("defineService with kit handlers", () => {
  it("refuses a service without a model, and handlers made for another contract", () => {
    expect(() =>
      qd.defineService(notes, {
        methods: {
          ...crud.handlers(notes, { access: { get: "authenticated", create: "authenticated" } }),
          rename: { access: "authenticated", handler: () => ({ id: "x" }) as never },
        },
      }),
    ).toThrow(
      'defineService("noteService"): method "get": the read/write kit reads and writes the service\'s rows: declare its model',
    );
    const twin = defineContract("noteService", { entity: taskEntity, methods: notes.methods });
    const madeForNotes = crud.handlers(notes, {
      access: { get: "authenticated", create: "authenticated" },
    });
    const definition = {
      model: "task",
      methods: { ...madeForNotes, rename: { access: "authenticated", handler: () => null } },
    };
    expect(() => qd.defineService(twin, definition as never)).toThrow(
      "its read/write kit handlers were made for another contract",
    );
  });

  it("serves the kit's methods, with no others, alongside hand-written ones", () => {
    const service = qd.defineService(notes, {
      model: "task",
      access: inherit({ from: projectContract, via: "projectId" }),
      methods: {
        ...crud.handlers(notes, { access: { get: { entry: "Read" }, create: "authenticated" } }),
        rename: {
          access: { entry: "Moderate" },
          handler: ({ input, db }) =>
            db.task.update({ where: { id: input.id }, data: { title: input.title } }),
        },
      },
    });
    expect(Object.keys(service.methods)).toEqual(["get", "create", "rename"]);
  });

  it("fails a kit handler called outside a dispatcher with INTERNAL", async () => {
    const { get } = crud.handlers(notes, { access: { get: "public", create: "public" } });
    await expect(
      get.handler({ input: { id: "t1" }, ctx: { principal: null }, db: {} }),
    ).rejects.toEqual(expect.any(QuickdrawError));
    await expect(
      get.handler({ input: { id: "t1" }, ctx: { principal: null }, db: {} }),
    ).rejects.toMatchObject({ code: "INTERNAL" });
  });
});

describe("the kit's MCP tools", () => {
  it("are made from the generated schemas, read-only for queries", () => {
    const tools = describeTools([defineTaskService()]);
    expect(tools.map((tool) => [tool.name, tool.annotations?.readOnlyHint])).toEqual([
      ["taskService_get", true],
      ["taskService_getMany", true],
      ["taskService_list", true],
      ["taskService_create", undefined],
      ["taskService_update", undefined],
      ["taskService_delete", undefined],
      ["taskService_reorder", undefined],
      ["taskService_bulkUpdate", undefined],
      ["taskService_bulkDelete", undefined],
    ]);
    const list = tools.find((tool) => tool.name === "taskService_list");
    expect(list?.inputSchema).toMatchObject({
      type: "object",
      properties: {
        filter: { properties: { status: { type: "string" }, assigneeId: {} } },
        sort: { properties: { field: { enum: ["ordinal", "title", "updatedAt"] } } },
      },
    });
    const update = tools.find((tool) => tool.name === "taskService_update");
    expect(update?.inputSchema).toMatchObject({ required: ["id"] });
    expect(Object.keys(taskContract.methods)).toHaveLength(9);
  });
});
