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
      check(byId(`t${index}`), false);
    }
    expect(raised).toEqual([]);
    for (let index = 0; index < 5; index += 1) {
      check(byId(`u${index}`), false);
    }
    expect(raised).toEqual([
      {
        kind: "n-plus-one",
        message:
          "task.findUnique by id ran 10 times in one call, once per item (N+1); read the rows in one query (findMany({ where: { id: { in: ids } } })), or write them together (createMany, updateMany, db.$transaction([...]))",
        meta: { model: "task", operation: "findUnique", where: ["id"] },
      },
    ]);
  });

  it("tell shapes apart by model, operation and where keys, not by values", () => {
    const { check, raised } = checks();
    for (let index = 0; index < 9; index += 1) {
      check(byId(`t${index}`), false);
      check({ model: "task", operation: "findFirst", args: { where: { id: `t${index}` } } }, false);
      check({ model: "label", operation: "findUnique", args: { where: { id: "l" } } }, false);
      check(
        { model: "task", operation: "count", args: { where: { projectId: "p", status: "x" } } },
        false,
      );
    }
    expect(raised).toEqual([]);
    check(
      { model: "task", operation: "count", args: { where: { status: "y", projectId: "q" } } },
      false,
    );
    expect(raised.map((warning) => warning.message.split(" ran ")[0])).toEqual([
      "task.count by projectId, status",
    ]);
  });

  it("count nothing sent together in an array-form transaction", () => {
    const { check, raised } = checks();
    for (let index = 0; index < 20; index += 1) {
      check(byId(`t${index}`), true);
    }
    expect(raised).toEqual([]);
  });

  it("know an unbounded read: findMany with neither take nor a filter on id", () => {
    const read = (args: Statement["args"]): Statement => ({
      model: "task",
      operation: "findMany",
      args,
    });
    expect(isUnboundedRead(read(undefined))).toBe(true);
    expect(isUnboundedRead(read({ where: { projectId: "p" } }))).toBe(true);
    expect(isUnboundedRead(read({ where: { projectId: "p" }, take: 20 }))).toBe(false);
    expect(isUnboundedRead(read({ where: { id: { in: ["a", "b"] } } }))).toBe(false);
    expect(isUnboundedRead({ model: "task", operation: "findFirst", args: {} })).toBe(false);
    const { check, raised } = checks();
    check(read({ where: { projectId: "p" } }), true);
    expect(raised.map((warning) => warning.kind)).toEqual(["unbounded-read"]);
    expect(raised[0]?.message).toBe(
      "task.findMany() without take reads every matching row, however many there are; add take (with a cursor to page), or serve the list as a collection or the read/write kit's list",
    );
  });
});
