// Keyset cursors (RFC 0003 section 7.3): what a cursor holds, which strings
// are not cursors, and the filter that continues after one. The cursor's
// behavior against a database (stable when rows are inserted before it,
// nullable columns) is in collections.test.ts.

import { describe, expect, it } from "vitest";
import type { OrderBy } from "../../contract/collections";
import { QuickdrawError } from "../../protocol/errors";
import { afterCursor, decodeCursor, encodeCursor, orderByOf } from "./cursor";

const byOrdinal: OrderBy = [
  ["ordinal", "asc"],
  ["id", "asc"],
];

const byDueDesc: OrderBy = [
  ["dueAt", "desc"],
  ["id", "asc"],
];

function issueOf(run: () => unknown): unknown {
  try {
    run();
  } catch (error) {
    return error instanceof QuickdrawError ? { code: error.code, data: error.data } : error;
  }
  return undefined;
}

describe("a cursor", () => {
  it("holds the row's value of each order column, id last, as base64url JSON", () => {
    const cursor = encodeCursor(byOrdinal, { id: "t9", ordinal: 3, title: "ignored" });
    expect(cursor).toMatch(/^[A-Za-z0-9_-]+$/);
    expect(JSON.parse(Buffer.from(cursor, "base64url").toString("utf8"))).toEqual([3, "t9"]);
    expect(decodeCursor(byOrdinal, cursor)).toEqual([3, "t9"]);
  });

  it("keeps dates, big integers and nulls", () => {
    const at = new Date("2026-10-02T12:00:00.000Z");
    const order: OrderBy = [
      ["dueAt", "asc"],
      ["size", "asc"],
      ["parentId", "asc"],
      ["id", "asc"],
    ];
    const cursor = encodeCursor(order, { id: "t1", dueAt: at, size: 12n, parentId: null });
    expect(decodeCursor(order, cursor)).toEqual([at, 12n, null, "t1"]);
  });

  it("is refused as VALIDATION when it is not a cursor of this order", () => {
    const refused = {
      code: "VALIDATION",
      data: {
        issues: [{ path: ["cursor"], message: "cursor is not a cursor of this collection" }],
      },
    };
    const encoded = (value: unknown) =>
      Buffer.from(JSON.stringify(value), "utf8").toString("base64url");
    expect(issueOf(() => decodeCursor(byOrdinal, "not a cursor"))).toEqual(refused);
    expect(issueOf(() => decodeCursor(byOrdinal, encoded([3])))).toEqual(refused);
    expect(issueOf(() => decodeCursor(byOrdinal, encoded([3, 4])))).toEqual(refused);
    expect(issueOf(() => decodeCursor(byOrdinal, encoded([{ x: 1 }, "t1"])))).toEqual(refused);
    expect(issueOf(() => decodeCursor(byOrdinal, encoded([{ $date: "never" }, "t1"])))).toEqual(
      refused,
    );
    expect(issueOf(() => decodeCursor(byOrdinal, encoded([3, ""])))).toEqual(refused);
  });
});

describe("the page after a cursor", () => {
  it("continues on a later value of the first column, or the same value and a later id", () => {
    expect(afterCursor(byOrdinal, [3, "t9"], new Set())).toEqual({
      OR: [{ ordinal: { gt: 3 } }, { AND: [{ ordinal: 3 }, { id: { gt: "t9" } }] }],
    });
  });

  it("includes the nulls that sort after a value in a nullable ascending column", () => {
    expect(afterCursor(byOrdinal, [3, "t9"], new Set(["ordinal"]))).toEqual({
      OR: [
        { OR: [{ ordinal: { gt: 3 } }, { ordinal: null }] },
        { AND: [{ ordinal: 3 }, { id: { gt: "t9" } }] },
      ],
    });
  });

  it("continues among the nulls, last when ascending", () => {
    expect(afterCursor(byOrdinal, [null, "t9"], new Set(["ordinal"]))).toEqual({
      AND: [{ ordinal: null }, { id: { gt: "t9" } }],
    });
  });

  it("places nulls first when descending: after one, every value; after a value, smaller ones", () => {
    expect(afterCursor(byDueDesc, [null, "t9"], new Set(["dueAt"]))).toEqual({
      OR: [{ dueAt: { not: null } }, { AND: [{ dueAt: null }, { id: { gt: "t9" } }] }],
    });
    expect(afterCursor(byDueDesc, ["2026-10-02", "t9"], new Set(["dueAt"]))).toEqual({
      OR: [
        { dueAt: { lt: "2026-10-02" } },
        { AND: [{ dueAt: "2026-10-02" }, { id: { gt: "t9" } }] },
      ],
    });
  });

  it("orders a nullable column with its nulls placed explicitly, and others as declared", () => {
    expect(orderByOf(byOrdinal, new Set())).toEqual([{ ordinal: "asc" }, { id: "asc" }]);
    expect(orderByOf(byOrdinal, new Set(["ordinal"]))).toEqual([
      { ordinal: { sort: "asc", nulls: "last" } },
      { id: "asc" },
    ]);
    expect(orderByOf(byDueDesc, new Set(["dueAt"]))).toEqual([
      { dueAt: { sort: "desc", nulls: "first" } },
      { id: "asc" },
    ]);
  });
});
