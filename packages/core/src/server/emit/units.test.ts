// The pure parts of projections and entity frames (RFC 0003 sections 2, 5.3
// and 6): where a projection's keys come from, what `defineService` refuses,
// projecting rows, field tiers, which frame a write makes, `affects`, and the
// change log.

import { describe, expect, it } from "vitest";
import { z } from "zod";
import { z as z3 } from "zod3";
import { defineContract, query, todoSchema } from "../../index";
import { initQuickdraw, type AnyService } from "../index";
import { createRegistry } from "../registry";
import { ANY_FIELD } from "../uow/types";
import { routesOf, touchedRows } from "./affects";
import { createChangeLog } from "./changeLog";
import { frameKind, selectFor } from "./frames";
import { isoDates, projectOutput, projectRow, schemaKeys, stripForReader } from "./projection";
import { strip, tiersOf } from "./tiers";

const qd = initQuickdraw();

const taskSchema = z.object({
  id: z.string(),
  title: z.string(),
  notes: z.string().nullable(),
  dueAt: z.string(),
  parentTaskId: z.string().nullable(),
});

const task = defineContract("taskService", {
  entity: taskSchema,
  projections: { card: taskSchema.pick({ id: true, title: true }) },
  fields: { notes: "Moderate", dueAt: "Admin" },
  methods: { get: query({ input: z.object({ id: z.string() }), output: "entity" }) },
});

const methods = { get: { access: "public", handler: () => null } } as const;

function defineLoosely(contract: unknown, definition: unknown): AnyService {
  return (qd.defineService as (contract: unknown, definition: unknown) => AnyService)(
    contract,
    definition,
  );
}

describe("a projection's keys", () => {
  it("come from the schema's Standard JSON Schema, following a top-level $ref", () => {
    expect(schemaKeys(taskSchema)).toEqual(["id", "title", "notes", "dueAt", "parentTaskId"]);
    expect(schemaKeys(z.object({ id: z.string() }).meta({ id: "Named" }))).toEqual(["id"]);
  });

  it("come from a migrated todoSchema's keys, and are unknown without them", () => {
    /* oxlint-disable quickdraw/no-todo-schema -- the placeholder is what this tests */
    expect(
      schemaKeys(todoSchema<{ id: string; title: string }>({ keys: ["id", "title"] })),
    ).toEqual(["id", "title"]);
    expect(schemaKeys(todoSchema<{ id: string }>())).toBeUndefined();
    /* oxlint-enable quickdraw/no-todo-schema */
  });

  it("are unknown for a schema that cannot describe itself", () => {
    expect(schemaKeys(z3.object({ id: z3.string() }))).toBeUndefined();
    expect(schemaKeys(z.object({ id: z.string(), at: z.date() }))).toBeUndefined();
    expect(
      schemaKeys(z.union([z.object({ id: z.string() }), z.object({ x: z.number() })])),
    ).toBeUndefined();
  });

  it("must be declared in project.keys when the schema cannot list them, or the service fails to define", () => {
    const legacy = defineContract("legacyService", {
      entity: z3.object({ id: z3.string(), title: z3.string() }),
      methods: { get: query({ input: z.object({ id: z.string() }), output: "entity" }) },
    });
    expect(() => defineLoosely(legacy, { methods })).toThrow(
      'defineService("legacyService"): projection "entity": its schema cannot list its keys (it has no Standard JSON Schema the framework can read); use Zod 4.2 or later for it, or declare them with project: { entity: { keys: [...] } }',
    );
    const service = defineLoosely(legacy, {
      methods,
      project: { entity: { keys: ["id", "title"] } },
    });
    expect(service.projections.get("entity")?.keys).toEqual(["id", "title"]);
  });

  it("are checked, as is every project entry", () => {
    expect(() => defineLoosely(task, { methods, project: { cards: {} } })).toThrow(
      'project names "cards", which is not a projection of the contract; the projections are "card", "entity"',
    );
    expect(() => defineLoosely(task, { methods, project: { card: { keys: ["title"] } } })).toThrow(
      'projection "card": keys must include "id"; every row is keyed by it',
    );
    expect(() =>
      defineLoosely(task, { methods, project: { card: { keys: ["id", "id"] } } }),
    ).toThrow('projection "card": keys must be a list of distinct field names');
    expect(() => defineLoosely(task, { methods, project: { card: { map: 1 } } })).toThrow(
      'projection "card": map must be a function of the row its select reads',
    );
    expect(() => defineLoosely(task, { methods, project: { card: { where: {} } } })).toThrow(
      'projection "card" has an unknown option "where"; the options are keys, select and map',
    );
  });
});

describe("defineService's data options", () => {
  it("checks writes, affects and versionColumn", () => {
    expect(() => defineLoosely(task, { methods, writes: "taskLabel" })).toThrow(
      'writes must be a list of model names, as the client names them ("taskLabel")',
    );
    expect(() =>
      defineLoosely(task, { methods, affects: [{ service: task, id: "parentTaskId" }] }),
    ).toThrow("affects needs model: it reads the written rows of the service's model");
    expect(() =>
      defineLoosely(task, { model: "task", methods, affects: [{ service: task, id: () => "t1" }] }),
    ).toThrow("affects[0]: id must be a column holding the affected row's id");
    expect(() =>
      defineLoosely(task, {
        model: "task",
        methods,
        affects: [{ service: {}, id: "parentTaskId" }],
      }),
    ).toThrow("affects[0] must be { service: contract, id }");
    expect(() => defineLoosely(task, { methods, versionColumn: "updatedAt" })).toThrow(
      "versionColumn must be a column of the service's model, so it needs model",
    );
    const service = defineLoosely(task, {
      model: "task",
      writes: ["taskLabel"],
      versionColumn: "updatedAt",
      affects: [
        { service: task, id: "parentTaskId" },
        {
          service: task,
          id: (row: { readonly ids?: unknown }) => row.ids as string[],
          columns: ["ids"],
        },
      ],
      methods,
    });
    expect(service.writes).toEqual(["taskLabel"]);
    expect(service.versionColumn).toBe("updatedAt");
    expect(
      service.affects.map((link) => [
        link.columns,
        link.ids({ parentTaskId: "p", ids: ["a", "b"] }),
      ]),
    ).toEqual([
      [["parentTaskId"], ["p"]],
      [["ids"], ["a", "b"]],
    ]);
  });
});

describe("projecting a row", () => {
  const service = defineLoosely(task, { methods });
  const entity = service.projections.get("entity");
  if (entity === undefined) {
    throw new Error("the entity projection is missing");
  }

  it("keeps the projection's keys and turns dates into ISO strings, at any depth", () => {
    const at = new Date("2026-10-02T12:00:00.000Z");
    expect(
      projectRow(entity, {
        id: "t1",
        title: "T",
        notes: null,
        dueAt: at,
        parentTaskId: null,
        ownerId: "u1",
      }),
    ).toEqual({
      id: "t1",
      title: "T",
      notes: null,
      dueAt: "2026-10-02T12:00:00.000Z",
      parentTaskId: null,
    });
    expect(isoDates({ list: [{ at }], when: at, n: 1 })).toEqual({
      list: [{ at: "2026-10-02T12:00:00.000Z" }],
      when: "2026-10-02T12:00:00.000Z",
      n: 1,
    });
    expect(projectRow(entity, "not a row")).toBe("not a row");
  });

  it("wraps one row, a nullable row and a list", () => {
    const row = { id: "t1", title: "T", extra: true };
    expect(projectOutput({ projection: entity, kind: "one" }, row)).toEqual({
      id: "t1",
      title: "T",
    });
    expect(projectOutput({ projection: entity, kind: "nullable" }, null)).toBeNull();
    expect(projectOutput({ projection: entity, kind: "list" }, [row, row])).toEqual([
      { id: "t1", title: "T" },
      { id: "t1", title: "T" },
    ]);
  });

  it("strips each row for its reader's level, and asks for levels only when a key is tiered", async () => {
    const asked: (readonly string[])[] = [];
    const rows = [
      { id: "a", title: "A", notes: "n", dueAt: "d" },
      { id: "b", title: "B", notes: "n", dueAt: "d" },
    ];
    const stripped = await stripForReader({ projection: entity, kind: "list" }, rows, (ids) => {
      asked.push(ids);
      return Promise.resolve(
        new Map([
          ["a", "Moderate"],
          ["b", "Read"],
        ] as const),
      );
    });
    expect(stripped).toEqual([
      { id: "a", title: "A", notes: "n" },
      { id: "b", title: "B" },
    ]);
    expect(rows[0]).toHaveProperty("dueAt");
    expect(asked).toEqual([["a", "b"]]);
    const card = service.projections.get("card");
    expect(card?.tiers.tiered).toBe(false);
    if (card !== undefined) {
      const untiered = await stripForReader({ projection: card, kind: "one" }, { id: "a" }, () =>
        Promise.reject(new Error("a projection without tiered keys asks for no levels")),
      );
      expect(untiered).toEqual({ id: "a" });
    }
  });
});

describe("field tiers", () => {
  it("hide a field below its level, and group the subscriber levels that see the same fields", () => {
    const tiers = tiersOf({ notes: "Moderate", dueAt: "Admin" }, ["id", "title", "notes", "dueAt"]);
    expect([...tiers.hidden(null)]).toEqual(["notes", "dueAt"]);
    expect([...tiers.hidden("Public")]).toEqual(["notes", "dueAt"]);
    expect([...tiers.hidden("Read")]).toEqual(["notes", "dueAt"]);
    expect([...tiers.hidden("Moderate")]).toEqual(["dueAt"]);
    expect([...tiers.hidden("Admin")]).toEqual([]);
    expect(tiers.groups.map((group) => group.levels)).toEqual([["Read"], ["Moderate"], ["Admin"]]);
    const one = tiersOf({ notes: "Admin" }, ["id", "notes"]);
    expect(one.groups.map((group) => group.levels)).toEqual([["Read", "Moderate"], ["Admin"]]);
    expect(tiersOf({}, ["id"]).tiered).toBe(false);
    const row = { id: "a", notes: "n" };
    expect(strip(row, new Set())).toBe(row);
    expect(strip(row, new Set(["notes"]))).toEqual({ id: "a" });
  });
});

describe("which frame a write makes", () => {
  const service = defineLoosely(task, { methods });
  const entity = service.projections.get("entity");
  const mapped = defineLoosely(task, {
    methods,
    project: { entity: { select: { title: true }, map: (row: unknown) => row } },
  }).projections.get("entity");
  if (entity === undefined || mapped === undefined) {
    throw new Error("the entity projection is missing");
  }

  it("is r for a delete, u for a create, and p for an update of projection fields only", () => {
    expect(frameKind(entity, { op: "delete", fields: [] }, undefined)).toEqual({ t: "r" });
    expect(frameKind(entity, { op: "create", fields: ["title"] }, undefined)).toEqual({ t: "u" });
    expect(frameKind(entity, { op: "update", fields: ["title"] }, undefined)).toEqual({
      t: "p",
      fields: ["title"],
    });
    expect(frameKind(entity, { op: "update", fields: ["title"] }, "dueAt")).toEqual({
      t: "p",
      fields: ["title", "dueAt"],
    });
  });

  it("is u for unknown fields, a field outside the projection, or a projection with map", () => {
    expect(frameKind(entity, { op: "update", fields: [ANY_FIELD] }, undefined)).toEqual({ t: "u" });
    expect(frameKind(entity, { op: "update", fields: ["title", "ownerId"] }, undefined)).toEqual({
      t: "u",
    });
    expect(frameKind(entity, { op: "update", fields: [] }, undefined)).toEqual({ t: "u" });
    expect(frameKind(mapped, { op: "update", fields: ["title"] }, undefined)).toEqual({ t: "u" });
  });

  it("reads only the patched fields when every row is a patch", () => {
    expect(
      selectFor(entity, [
        { t: "p", fields: ["title"] },
        { t: "p", fields: ["notes"] },
      ]),
    ).toEqual({
      id: true,
      title: true,
      notes: true,
    });
    expect(selectFor(entity, [{ t: "p", fields: ["title"] }, { t: "u" }])).toBe(entity.select);
    expect(mapped.select).toEqual({ id: true, title: true });
  });
});

describe("affects", () => {
  it("adds the rows a written row points at, once each, whole, unless the flush deleted them", () => {
    const linked = defineLoosely(task, {
      model: "task",
      affects: [{ service: task, id: "parentTaskId" }],
      methods,
    });
    const registry = createRegistry([linked]);
    const interest: string[][] = [];
    const routes = routesOf(registry, {
      registerInterest: (_model: string, columns: readonly string[]) => interest.push([...columns]),
    } as never);
    expect(interest).toEqual([["parentTaskId"]]);
    const touched = touchedRows(
      [
        { model: "task", id: "c1", op: "update", fields: ["title"], after: { parentTaskId: "p1" } },
        {
          model: "Task",
          id: "c2",
          op: "update",
          fields: ["parentTaskId"],
          before: { parentTaskId: "p2" },
          after: { parentTaskId: "p1" },
        },
        { model: "task", id: "p3", op: "delete", fields: [] },
        { model: "task", id: "c3", op: "delete", fields: [], before: { parentTaskId: "p3" } },
      ],
      routes,
    );
    expect(Object.fromEntries(touched.get(linked) ?? [])).toEqual({
      c1: { op: "update", fields: ["title"] },
      c2: { op: "update", fields: ["parentTaskId"] },
      p3: { op: "delete", fields: [] },
      c3: { op: "delete", fields: [] },
      p1: { op: "update", fields: [ANY_FIELD] },
      p2: { op: "update", fields: [ANY_FIELD] },
    });
  });

  it("refuses a link to a service the dispatcher does not serve", () => {
    const other = defineContract("otherService", { entity: taskSchema, methods: {} });
    const linked = defineLoosely(task, {
      model: "task",
      affects: [{ service: other, id: "parentTaskId" }],
      methods,
    });
    expect(() => routesOf(createRegistry([linked]), undefined)).toThrow(
      "createDispatcher: taskService affects otherService, which this dispatcher does not serve",
    );
  });
});

describe("the change log", () => {
  it("answers unchanged since a revision, and keeps a floor for what it dropped", () => {
    const log = createChangeLog({ maxEntries: 2 });
    const start = log.lastChange("s", "never");
    expect(log.unchangedSince("s", "never", start)).toBe(true);
    expect(log.unchangedSince("s", "never", start - 1)).toBe(false);
    log.record("s", "a", start + 10, false);
    log.record("s", "b", start + 20, true);
    expect(log.lastChange("s", "a")).toBe(start + 10);
    expect(log.removed("s", "b")).toBe(true);
    expect(log.unchangedSince("s", "a", start + 10)).toBe(true);
    expect(log.unchangedSince("s", "a", start + 9)).toBe(false);
    log.record("s", "a", start + 5, false);
    expect(log.lastChange("s", "a")).toBe(start + 10);
    log.record("s", "c", start + 30, false);
    // "b" was the least recently written; dropping it raised the floor to its revision.
    expect(log.lastChange("s", "b")).toBe(start + 20);
    expect(log.removed("s", "b")).toBe(false);
    expect(log.lastChange("s", "never")).toBe(start + 20);
    expect(() => createChangeLog({ maxEntries: 0 })).toThrow(
      "createDispatcher: changeLog.maxEntries must be a positive whole number",
    );
  });
});
