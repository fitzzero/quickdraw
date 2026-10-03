import { describe, expect, it } from "vitest";
import { mergeRecords } from "./records";
import { ANY_FIELD, type WriteRecord } from "./types";

const task = (
  op: WriteRecord["op"],
  fields: readonly string[] = [],
  extra: Partial<WriteRecord> = {},
): WriteRecord => ({ model: "task", id: "t1", op, fields, ...extra });

describe("mergeRecords", () => {
  it("keeps one record per row, in the order rows were first written", () => {
    const merged = mergeRecords([
      { model: "task", id: "t2", op: "update", fields: ["title"] },
      { model: "task", id: "t1", op: "update", fields: ["status"] },
      { model: "project", id: "t2", op: "update", fields: ["name"] },
      { model: "task", id: "t2", op: "update", fields: ["ordinal"] },
    ]);
    expect(merged).toEqual([
      { model: "task", id: "t2", op: "update", fields: ["title", "ordinal"] },
      { model: "task", id: "t1", op: "update", fields: ["status"] },
      { model: "project", id: "t2", op: "update", fields: ["name"] },
    ]);
  });

  it("unions the fields of ten updates to one row", () => {
    const updates = Array.from({ length: 10 }, (_, index) =>
      task("update", [index % 2 === 0 ? "title" : "status", `field${index % 3}`]),
    );
    const merged = mergeRecords(updates);
    expect(merged).toHaveLength(1);
    expect(merged[0]?.op).toBe("update");
    expect([...(merged[0]?.fields ?? [])].sort()).toEqual([
      "field0",
      "field1",
      "field2",
      "status",
      "title",
    ]);
  });

  it("keeps a create created then updated, without before values", () => {
    expect(
      mergeRecords([
        task("create", ["title"], { after: { projectId: "p1" } }),
        task("update", ["projectId"], { before: { projectId: "p1" }, after: { projectId: "p2" } }),
      ]),
    ).toEqual([task("create", ["title", "projectId"], { after: { projectId: "p2" } })]);
  });

  it("cancels a row created and deleted in one unit to a delete", () => {
    expect(
      mergeRecords([
        task("create", ["title"], { after: { projectId: "p1" } }),
        task("delete", [], { before: { projectId: "p1" } }),
      ]),
    ).toEqual([task("delete", ["title"])]);
  });

  it("makes an updated then deleted row a delete that keeps the oldest values", () => {
    expect(
      mergeRecords([
        task("update", ["projectId"], { before: { projectId: "p1" }, after: { projectId: "p2" } }),
        task("delete", [], { before: { projectId: "p2", status: "done" } }),
      ]),
    ).toEqual([task("delete", ["projectId"], { before: { projectId: "p1", status: "done" } })]);
  });

  it("makes a row deleted and created again a create that keeps where it was before", () => {
    expect(
      mergeRecords([
        task("delete", [], { before: { projectId: "p1" } }),
        task("create", ["title", "projectId"], { after: { projectId: "p2" } }),
      ]),
    ).toEqual([
      task("create", ["title", "projectId"], {
        before: { projectId: "p1" },
        after: { projectId: "p2" },
      }),
    ]);
  });

  it("keeps the earliest before and the latest after of each column", () => {
    expect(
      mergeRecords([
        task("update", ["projectId"], { before: { projectId: "p1" }, after: { projectId: "p2" } }),
        task("update", ["projectId", "status"], {
          before: { projectId: "p2", status: "open" },
          after: { projectId: "p3", status: "done" },
        }),
      ]),
    ).toEqual([
      task("update", ["projectId", "status"], {
        before: { projectId: "p1", status: "open" },
        after: { projectId: "p3", status: "done" },
      }),
    ]);
  });

  it("reports unknown fields once when a touch is merged with a tracked write", () => {
    expect(mergeRecords([task("update", ["title"]), task("update", [ANY_FIELD])])).toEqual([
      task("update", [ANY_FIELD]),
    ]);
  });

  it("returns a lone record as it is, and nothing for nothing", () => {
    const only = task("update", ["title"]);
    expect(mergeRecords([only])[0]).toBe(only);
    expect(mergeRecords([])).toEqual([]);
  });
});
