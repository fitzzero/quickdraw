// The development checks of one method call's statements: N+1 shapes and
// unbounded reads (`statementChecks.ts`).

import { describe, expect, it } from "vitest";
import { N_PLUS_ONE_STATEMENTS } from "../devWarnings";
import { createStatementChecks, isUnboundedRead, type Statement } from "./statementChecks";

function checks() {
  const raised: { kind: string; message: string; meta?: unknown }[] = [];
  const check = createStatementChecks((warning) => raised.push(warning));
  return { check, raised };
}

const byId = (id: string): Statement => ({
  model: "task",
  operation: "findUnique",
  args: { where: { id } },
});

describe("statement checks", () => {
  it("raise one N+1 warning when one shape reaches ten statements in a call", () => {
    const { check, raised } = checks();
    for (let index = 0; index < N_PLUS_ONE_STATEMENTS - 1; index += 1) {
      check(byId(`t${index}`), "unit");
    }
    expect(raised).toEqual([]);
    for (let index = 0; index < 5; index += 1) {
      check(byId(`u${index}`), "unit");
    }
    expect(raised).toEqual([
      {
        kind: "n-plus-one",
        message:
          "task.findUnique by id ran 10 times in one call, once per item (N+1); read the rows in one query (findMany({ where: { id: { in: ids } } })), write them in one when every row gets the same data (updateMany, createMany), or write each row by id inside an interactive transaction (db.$transaction(async (tx) => ...))",
        meta: { model: "task", operation: "findUnique", where: ["id"] },
      },
    ]);
  });

  it("tell shapes apart by model, operation and where keys, not by values", () => {
    const { check, raised } = checks();
    for (let index = 0; index < 9; index += 1) {
      check(byId(`t${index}`), "unit");
      check(
        { model: "task", operation: "findFirst", args: { where: { id: `t${index}` } } },
        "unit",
      );
      check({ model: "label", operation: "findUnique", args: { where: { id: "l" } } }, "unit");
      check(
        { model: "task", operation: "count", args: { where: { projectId: "p", status: "x" } } },
        "unit",
      );
    }
    expect(raised).toEqual([]);
    check(
      { model: "task", operation: "count", args: { where: { status: "y", projectId: "q" } } },
      "unit",
    );
    expect(raised.map((warning) => warning.message.split(" ran ")[0])).toEqual([
      "task.count by projectId, status",
    ]);
  });

  it("count nothing sent together in an array-form transaction", () => {
    const { check, raised } = checks();
    for (let index = 0; index < 20; index += 1) {
      check(byId(`t${index}`), "batch");
    }
    expect(raised).toEqual([]);
  });

  it("count no update or delete by id inside an interactive transaction (the per-row write form)", () => {
    const { check, raised } = checks();
    const write = (operation: string, where: Record<string, unknown>): Statement => ({
      model: "task",
      operation,
      args: { where, data: { projectId: "p2" } },
    });
    for (let index = 0; index < 20; index += 1) {
      check(write("update", { id: `t${index}` }), "interactive");
      check(write("delete", { id: `t${index}` }), "interactive");
    }
    expect(raised).toEqual([]);
    // Other shapes in a transaction still count: reads by id, writes by other keys.
    for (let index = 0; index < 10; index += 1) {
      check(byId(`t${index}`), "interactive");
      check(write("update", { id: `t${index}`, projectId: "p" }), "interactive");
    }
    expect(raised.map((warning) => warning.message.split(" ran ")[0])).toEqual([
      "task.findUnique by id",
      "task.update by id, projectId",
    ]);
    // The same updates in the call's own unit are an N+1.
    const unit = checks();
    for (let index = 0; index < 10; index += 1) {
      unit.check(write("update", { id: `t${index}` }), "unit");
    }
    expect(unit.raised.map((warning) => warning.kind)).toEqual(["n-plus-one"]);
  });

  it("count no statement filtered by an id list: one per chunk of ids, as lint allows", () => {
    const { check, raised } = checks();
    for (let index = 0; index < 20; index += 1) {
      const chunk = [`t${index}`, `u${index}`];
      check(
        { model: "task", operation: "findMany", args: { where: { id: { in: chunk } } } },
        "unit",
      );
      check(
        {
          model: "task",
          operation: "updateMany",
          args: { where: { id: { in: chunk }, status: "open" }, data: { seen: true } },
        },
        "unit",
      );
    }
    expect(raised).toEqual([]);
    // An id filter that is not a list is still a shape that counts.
    for (let index = 0; index < 10; index += 1) {
      check(
        { model: "task", operation: "findMany", args: { where: { id: { not: "x" } }, take: 1 } },
        "unit",
      );
    }
    expect(raised.map((warning) => warning.kind)).toEqual(["n-plus-one"]);
  });

  it("know an unbounded read: findMany with neither take nor ids to read", () => {
    const read = (args: Statement["args"]): Statement => ({
      model: "task",
      operation: "findMany",
      args,
    });
    expect(isUnboundedRead(read(undefined))).toBe(true);
    expect(isUnboundedRead(read({ where: { projectId: "p" } }))).toBe(true);
    expect(isUnboundedRead(read({ where: { projectId: "p" }, take: 20 }))).toBe(false);
    expect(isUnboundedRead(read({ where: { id: { in: ["a", "b"] } } }))).toBe(false);
    expect(isUnboundedRead(read({ where: { id: "a" } }))).toBe(false);
    expect(isUnboundedRead(read({ where: { id: { equals: "a" } } }))).toBe(false);
    // The review's bad5 case: these leave every other row.
    expect(isUnboundedRead(read({ where: { id: { not: "a" } } }))).toBe(true);
    expect(isUnboundedRead(read({ where: { id: { notIn: ["a"] } } }))).toBe(true);
    expect(isUnboundedRead(read({ where: { id: { gt: "a" } } }))).toBe(true);
    expect(isUnboundedRead({ model: "task", operation: "findFirst", args: {} })).toBe(false);
    const { check, raised } = checks();
    check(read({ where: { projectId: "p" } }), "batch");
    expect(raised.map((warning) => warning.kind)).toEqual(["unbounded-read"]);
    expect(raised[0]?.message).toBe(
      "task.findMany() without take reads every matching row, however many there are; add take (with a cursor to page), or serve the list as a collection or the read/write kit's list",
    );
  });
});
