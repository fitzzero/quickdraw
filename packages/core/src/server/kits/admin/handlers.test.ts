// `admin.handlers` (RFC 0003 section 12.4): implementations for exactly the
// admin kit's methods of a contract, each under `{ service: "Admin" }` unless
// `access` says otherwise; the options and the services it refuses; and its
// methods served as MCP tools like any method.

import { describe, expect, it } from "vitest";
import { z } from "zod";
import { admin as contractAdmin, defineContract, QuickdrawError } from "../../../index";
import { qd } from "../../emit/__tests__/live";
import { describeTools } from "../../mcp/index";
import { admin, owner } from "../../index";
import { defineTaskService, taskContract, taskEntity } from "./__tests__/fixture";

const notes = defineContract("noteService", {
  entity: taskEntity,
  methods: {
    ...contractAdmin.contract({
      entity: taskEntity,
      filter: ["status"],
      expose: ["adminList", "adminGet", "adminUpdate", "adminMeta"],
    }),
  },
});

type Options = Parameters<typeof admin.handlers<typeof notes>>[1];

function refuse(options: unknown, contract: object = notes) {
  return () => admin.handlers(contract as typeof notes, options as Options);
}

describe("admin.handlers", () => {
  it("implements exactly the kit's methods, each under a service-wide Admin grant", () => {
    const handlers = admin.handlers(notes);
    expect(Object.keys(handlers)).toEqual(["adminList", "adminGet", "adminUpdate", "adminMeta"]);
    for (const method of Object.values(handlers)) {
      expect(method.access).toEqual({ service: "Admin" });
      expect(method.handler).toBeTypeOf("function");
    }
    expect(Object.isFrozen(handlers)).toBe(true);
    // The server's admin carries the contract half too.
    expect(admin.contract).toBe(contractAdmin.contract);
  });

  it("gives a method the form access names, and the rest the default", () => {
    const handlers = admin.handlers(notes, {
      access: { adminGet: { entry: "Admin" }, adminMeta: "authenticated" },
    });
    expect(handlers.adminGet.access).toEqual({ entry: "Admin" });
    expect(handlers.adminMeta.access).toBe("authenticated");
    expect(handlers.adminList.access).toEqual({ service: "Admin" });
  });

  it("follows an admin method the contract renamed", () => {
    const kit = contractAdmin.contract({ entity: taskEntity, expose: ["adminGet"] });
    const renamed = defineContract("renamedService", {
      entity: taskEntity,
      methods: { inspect: kit.adminGet },
    });
    expect(Object.keys(admin.handlers(renamed))).toEqual(["inspect"]);
  });

  it("refuses malformed options, a contract without the kit, and an entity that is not the contract's", () => {
    expect(refuse({ access: { rename: "public" } })).toThrow(
      'admin.handlers: access names "rename", which is not a method admin.contract made',
    );
    expect(refuse({ access: { adminGet: "everyone" } })).toThrow(
      'access for "adminGet" must be "public"',
    );
    expect(refuse({ hidden: ["notes"] })).toThrow('options has an unknown key "hidden"');
    expect(refuse({ displayName: "" })).toThrow("displayName must be a non-empty string");
    const plain = defineContract("plainService", { entity: taskEntity });
    expect(refuse(undefined, plain)).toThrow(
      "admin.handlers: plainService has no method admin.contract made",
    );
    const other = defineContract("otherService", {
      entity: taskEntity.extend({ extra: z.string() }),
      methods: { ...contractAdmin.contract({ entity: taskEntity, expose: ["adminGet"] }) },
    });
    expect(refuse(undefined, other)).toThrow(
      "admin.contract was given another schema than otherService's entity",
    );
    expect(refuse(undefined, { name: "x", methods: {} })).toThrow(
      "the first argument must be a contract from defineContract",
    );
  });

  it("refuses hidden fields and overrides that name no field, hide id or a listed field, or unlock a timestamp", () => {
    expect(refuse({ hiddenFields: ["nope"] })).toThrow(
      'hiddenFields: "nope" is not a field of the entity that can be hidden',
    );
    expect(refuse({ hiddenFields: ["id"] })).toThrow(
      '"id" is not a field of the entity that can be hidden',
    );
    expect(refuse({ hiddenFields: ["status"] })).toThrow(
      '"status" is hidden, so adminList may not filter or sort on it',
    );
    expect(refuse({ fieldOverrides: { nope: { label: "No" } } })).toThrow(
      'fieldOverrides: "nope" is not a field of the entity the kit shows',
    );
    expect(refuse({ hiddenFields: ["notes"], fieldOverrides: { notes: { label: "N" } } })).toThrow(
      '"notes" is not a field of the entity the kit shows',
    );
    expect(refuse({ fieldOverrides: { createdAt: { editable: true } } })).toThrow(
      'fieldOverrides: "createdAt" is never editable; the database sets it',
    );
    expect(refuse({ fieldOverrides: { title: { sortable: true } } })).toThrow(
      'fieldOverrides for "title" has an unknown key "sortable"',
    );
    expect(refuse({ fieldOverrides: { title: { type: "text" } } })).toThrow(
      'fieldOverrides for "title" has a type, label, enumValues or relationService of the wrong kind',
    );
  });
});

describe("defineService with the admin kit", () => {
  it("refuses a service without a model, and handlers made for another contract", () => {
    expect(() => qd.defineService(notes, { methods: { ...admin.handlers(notes) } })).toThrow(
      'defineService("noteService"): method "adminList": the admin kit reads and writes the service\'s rows: declare its model',
    );
    const twin = defineContract("noteService", { entity: taskEntity, methods: notes.methods });
    const definition = { model: "task", methods: { ...admin.handlers(notes) } };
    expect(() => qd.defineService(twin, definition as never)).toThrow(
      "its admin kit handlers were made for another contract",
    );
  });

  it("refuses a method on one row under a form below Admin that checks no row, unless rowless names it", () => {
    const define = (options: Options) => () =>
      qd.defineService(notes, {
        model: "task",
        access: owner("assigneeId"),
        methods: { ...admin.handlers(notes, options) },
      });
    expect(define({})).not.toThrow();
    expect(define({ access: { adminGet: { service: "Moderate" } } })).toThrow(
      'method "adminGet" takes a row id (its input has id), but its access { service: "Moderate" } checks no row',
    );
    expect(define({ access: { adminUpdate: "authenticated" } })).toThrow(
      'name it in the kit\'s rowless option (rowless: ["adminUpdate"])',
    );
    // a list is the kit's own every-row read; a form on it names who may page through every row
    expect(define({ access: { adminList: { service: "Moderate" } } })).not.toThrow();
    const service = define({
      access: { adminGet: { service: "Moderate" } },
      rowless: ["adminGet"],
    })();
    expect(service.methods.adminGet?.rowless).toBe(true);
    expect(refuse({ rowless: ["adminReemit"] })).toThrow(
      'admin.handlers: rowless names "adminReemit", which is not one of the kit\'s methods',
    );
  });

  it("fails a kit handler called outside a dispatcher with INTERNAL", async () => {
    const { adminGet } = admin.handlers(notes);
    await expect(
      adminGet.handler({ input: { id: "t1" }, ctx: { principal: null }, db: {} }),
    ).rejects.toEqual(expect.any(QuickdrawError));
    await expect(
      adminGet.handler({ input: { id: "t1" }, ctx: { principal: null }, db: {} }),
    ).rejects.toMatchObject({ code: "INTERNAL" });
  });
});

describe("the kit's MCP tools", () => {
  it("are made from the generated schemas, read-only for queries", () => {
    const tools = describeTools([defineTaskService()]).filter((tool) =>
      tool.name.startsWith("taskService_admin"),
    );
    expect(tools.map((tool) => [tool.name, tool.annotations?.readOnlyHint])).toEqual([
      ["taskService_adminList", true],
      ["taskService_adminGet", true],
      ["taskService_adminCreate", undefined],
      ["taskService_adminUpdate", undefined],
      ["taskService_adminDelete", undefined],
      ["taskService_adminMeta", true],
      ["taskService_adminSubscribers", true],
      ["taskService_adminReemit", undefined],
    ]);
    const schemaOf = (name: string) => tools.find((tool) => tool.name === name)?.inputSchema;
    expect(schemaOf("taskService_adminList")).toMatchObject({
      type: "object",
      properties: {
        filter: { properties: { status: { enum: ["open", "doing", "done"] }, pinned: {} } },
        sort: { properties: { field: { enum: ["createdAt", "title", "ordinal"] } } },
        page: { minimum: 1 },
        pageSize: { maximum: 100 },
      },
      additionalProperties: false,
    });
    const update = schemaOf("taskService_adminUpdate") as unknown as {
      readonly required: readonly string[];
      readonly properties: { readonly data: { readonly properties: object } };
      readonly definitions?: object;
    };
    expect(update.required).toEqual(["id", "data"]);
    expect(Object.keys(update.properties.data.properties)).toEqual([
      "projectId",
      "title",
      "status",
      "ordinal",
      "pinned",
      "details",
      "assigneeId",
      "notes",
    ]);
    // details is z.json(): its $ref points into definitions the tool's schema carries.
    expect(update.definitions).toBeDefined();
    expect(schemaOf("taskService_adminMeta")).toMatchObject({ type: "object", properties: {} });
    expect(Object.keys(taskContract.methods)).toHaveLength(10);
  });
});
