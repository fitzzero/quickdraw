import { describe, expect, it } from "vitest";
import { findNestedWrites } from "./nested";

describe("findNestedWrites", () => {
  it("finds each relation field that writes a related row", () => {
    expect(
      findNestedWrites({
        title: "x",
        labels: { create: [{ name: "a" }] },
        project: { connect: { id: "p1" } },
        assignee: { disconnect: true },
        subtasks: { updateMany: { where: {}, data: {} }, deleteMany: {} },
      }),
    ).toEqual([
      { field: "labels", operation: "create" },
      { field: "project", operation: "connect" },
      { field: "assignee", operation: "disconnect" },
      { field: "subtasks", operation: "updateMany" },
    ]);
  });

  it("tells a relation's set from a scalar's", () => {
    expect(
      findNestedWrites({
        title: { set: "renamed" },
        tags: { set: ["a", "b"] },
        cleared: { set: null },
        labels: { set: [{ id: "l1" }] },
      }),
    ).toEqual([{ field: "labels", operation: "set" }]);
  });

  it("judges each key by its value: a JSON column's literal flags are not relation operations", () => {
    // The review's jsonNested case.
    expect(
      findNestedWrites({
        details: { create: true, update: true, delete: false },
        settings: { connect: "x", upsert: 1, deleteMany: null, disconnect: false, createMany: 0 },
      }),
    ).toEqual([]);
    expect(
      findNestedWrites({
        owner: { delete: true },
        members: { delete: [{ id: "m1" }] },
        labels: { connect: [] },
        project: { update: { name: "x" } },
      }),
    ).toEqual([
      { field: "owner", operation: "delete" },
      { field: "members", operation: "delete" },
      { field: "labels", operation: "connect" },
      { field: "project", operation: "update" },
    ]);
  });

  it("ignores scalars, atomic operations, dates, arrays and anything that is not data", () => {
    expect(
      findNestedWrites({
        ordinal: { increment: 1 },
        dueAt: new Date(),
        list: [{ create: 1 }],
        note: null,
      }),
    ).toEqual([]);
    expect(findNestedWrites(undefined)).toEqual([]);
    expect(findNestedWrites([{ labels: { create: [] } }])).toEqual([]);
  });
});
