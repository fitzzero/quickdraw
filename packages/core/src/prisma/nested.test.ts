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
