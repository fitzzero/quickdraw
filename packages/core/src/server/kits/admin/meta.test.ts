// `adminMeta` (RFC 0003 section 12.4): the field configurations an admin
// screen is built from, derived from the entity schema's JSON Schema with
// 4.1's rules (`legacy-src/server/utils/zodToAdminFields.ts:138-265`), and
// what `hiddenFields`, `fieldOverrides` and `displayName` change, in what the
// kit returns and writes as well as in the metadata.

import { describe, expect, it } from "vitest";
import { z } from "zod";
import { z as z3 } from "zod3";
import { admin as adminContract, defineContract } from "../../../index";
import { createTestApp, type TestApp } from "../../../testing/index";
import { projectContract, projectService, qd } from "../../emit/__tests__/live";
import { admin, inherit } from "../../index";
import { adminApp, as, serviceAdmin, taskContract } from "./__tests__/fixture";
import { displayNameOf, labelOf } from "./meta";

const kit = adminApp();

describe("adminMeta", () => {
  it("describes the fixture task's string, number, boolean, date, enum and JSON fields", async () => {
    const { app } = await kit.start();
    const meta = await app.as(serviceAdmin(kit.board().ed)).taskService.adminMeta();
    expect(meta).toMatchInlineSnapshot(`
      {
        "displayName": "Tasks",
        "fields": [
          {
            "editable": false,
            "filterable": false,
            "label": "ID",
            "name": "id",
            "required": true,
            "showInTable": true,
            "sortable": false,
            "type": "string",
          },
          {
            "editable": false,
            "filterable": false,
            "label": "Created At",
            "name": "createdAt",
            "required": true,
            "showInTable": true,
            "sortable": true,
            "type": "date",
          },
          {
            "editable": false,
            "filterable": false,
            "label": "Updated At",
            "name": "updatedAt",
            "required": true,
            "showInTable": false,
            "sortable": false,
            "type": "date",
          },
          {
            "editable": true,
            "filterable": true,
            "label": "Project Id",
            "name": "projectId",
            "required": true,
            "showInTable": true,
            "sortable": false,
            "type": "string",
          },
          {
            "editable": true,
            "filterable": false,
            "label": "Title",
            "name": "title",
            "required": true,
            "showInTable": true,
            "sortable": true,
            "type": "string",
          },
          {
            "editable": true,
            "enumValues": [
              "open",
              "doing",
              "done",
            ],
            "filterable": true,
            "label": "Status",
            "name": "status",
            "required": true,
            "showInTable": true,
            "sortable": false,
            "type": "enum",
          },
          {
            "editable": true,
            "filterable": false,
            "label": "Ordinal",
            "name": "ordinal",
            "required": true,
            "showInTable": true,
            "sortable": true,
            "type": "number",
          },
          {
            "editable": true,
            "filterable": true,
            "label": "Pinned",
            "name": "pinned",
            "required": true,
            "showInTable": true,
            "sortable": false,
            "type": "boolean",
          },
          {
            "editable": true,
            "filterable": false,
            "label": "Details",
            "name": "details",
            "required": false,
            "showInTable": false,
            "sortable": false,
            "type": "json",
          },
          {
            "editable": true,
            "filterable": false,
            "label": "Assignee Id",
            "name": "assigneeId",
            "required": false,
            "showInTable": true,
            "sortable": false,
            "type": "string",
          },
          {
            "editable": true,
            "filterable": false,
            "label": "Notes",
            "name": "notes",
            "required": false,
            "showInTable": true,
            "sortable": false,
            "type": "string",
          },
        ],
        "serviceName": "taskService",
      }
    `);
  });

  it("leaves hidden fields out of the metadata, the rows and the writes", async () => {
    const { app } = await kit.start({ hiddenFields: ["details", "assigneeId"] });
    const board = kit.board();
    const administrator = app.as(serviceAdmin(board.ed)).taskService;
    const names = (await administrator.adminMeta()).fields.map((field) => field.name);
    expect(names).not.toContain("details");
    expect(names).not.toContain("assigneeId");
    const row = await administrator.adminGet({ id: board.t1 });
    expect(row).not.toHaveProperty("details");
    expect(row).not.toHaveProperty("assigneeId");
    expect((await administrator.adminList()).items.every((item) => !("details" in item))).toBe(
      true,
    );
    await expect(
      administrator.adminUpdate({ id: board.t1, data: { details: { x: 1 } } }),
    ).rejects.toMatchObject({
      code: "VALIDATION",
      data: {
        issues: [{ path: ["data", "details"], message: '"details" is not a writable field' }],
      },
    });
  });

  it("names the service from its contract name unless displayName says otherwise", async () => {
    const plain = await kit.start();
    const named = await kit.start({ displayName: "Work items" });
    const board = kit.board();
    expect((await plain.app.as(serviceAdmin(board.ed)).taskService.adminMeta()).displayName).toBe(
      "Tasks",
    );
    expect((await named.app.as(serviceAdmin(board.ed)).taskService.adminMeta()).displayName).toBe(
      "Work items",
    );
    expect(displayNameOf("chatMessageService")).toBe("Chat Messages");
    expect(labelOf("assigneeId")).toBe("Assignee Id");
    expect(labelOf("user_id")).toBe("User Id");
  });

  it("applies fieldOverrides, and refuses writes to a field an override made read-only", async () => {
    const overridden = qd.defineService(taskContract, {
      model: "task",
      access: inherit({ from: projectContract, via: "projectId" }),
      collections: { board: { anchor: projectContract } },
      methods: {
        ...admin.handlers(taskContract, {
          fieldOverrides: {
            title: { label: "Name", editable: false },
            details: { showInTable: true },
            assigneeId: { type: "relation", relationService: "userService" },
          },
        }),
        get: { access: { entry: "Read" }, handler: () => null as never },
        update: { access: { entry: "Moderate" }, handler: () => null as never },
      },
    });
    const app = await createTestApp({
      services: [projectService, overridden],
      db: kit.harness().db,
    });
    kit.track(app as unknown as TestApp);
    const board = kit.board();
    const administrator = app.as(serviceAdmin(board.ed)).taskService;
    const fields = (await administrator.adminMeta()).fields;
    expect(fields.find((field) => field.name === "title")).toMatchObject({
      label: "Name",
      editable: false,
      sortable: true,
    });
    expect(fields.find((field) => field.name === "details")).toMatchObject({ showInTable: true });
    expect(fields.find((field) => field.name === "assigneeId")).toMatchObject({
      type: "relation",
      relationService: "userService",
    });
    await expect(
      administrator.adminUpdate({ id: board.t1, data: { title: "Renamed" } }),
    ).rejects.toMatchObject({
      code: "VALIDATION",
      data: { issues: [{ path: ["data", "title"], message: '"title" is not editable' }] },
    });
  });
});

describe("the entity schema", () => {
  it("must describe itself as JSON Schema, as for MCP tools", () => {
    const zod3 = z3.object({ id: z3.string(), title: z3.string() });
    expect(() => adminContract.contract({ entity: zod3 })).toThrow(
      "admin.contract: the entity schema cannot describe itself as JSON Schema, which the admin kit's field metadata needs: use Zod 4.2 or later for that schema",
    );
    const dated = z.object({ id: z.string(), due: z.date() });
    expect(() => adminContract.contract({ entity: dated })).toThrow(
      "the entity schema cannot be written as JSON Schema (Date cannot be represented in JSON Schema)",
    );
  });

  it("gives nullable, defaulted and union fields their types, and their required flags", async () => {
    const entity = z.object({
      id: z.string(),
      due: z.iso.date().nullable(),
      size: z.union([z.literal("S"), z.literal("M")]),
      mixed: z.union([z.string(), z.number()]),
      tags: z.array(z.string()),
      count: z.number().default(0),
      label: z.string().optional(),
      anything: z.unknown(),
    });
    const contract = defineContract("shapeService", {
      entity,
      methods: { ...adminContract.contract({ entity, expose: ["adminMeta"] }) },
    });
    const service = qd.defineService(contract, {
      model: "task",
      methods: { ...admin.handlers(contract) },
    });
    const app = await createTestApp({ services: [service], db: kit.harness().db });
    kit.track(app as unknown as TestApp);
    const meta = await app
      .as(as(kit.board().ed, { shapeService: "Admin" }))
      .shapeService.adminMeta();
    const kinds = Object.fromEntries(
      meta.fields.map((field) => [field.name, [field.type, field.required, field.enumValues]]),
    );
    expect(kinds).toEqual({
      id: ["string", true, undefined],
      due: ["date", false, undefined],
      size: ["enum", true, ["S", "M"]],
      mixed: ["string", true, undefined],
      tags: ["json", true, undefined],
      count: ["number", false, undefined],
      label: ["string", false, undefined],
      anything: ["json", false, undefined],
    });
  });
});
