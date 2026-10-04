// Type tests for `describeAccessMatrix`: a case's method and input are typed
// by the service's contract, and the names in `allow` and `expect` by the
// principals given (plus `"anonymous"`).

import { describe, expectTypeOf, test } from "vitest";
import { z } from "zod";
import { defineContract, mutation, query } from "../index";
import { initQuickdraw, type Principal } from "../server/index";
import { describeAccessMatrix, type AccessMatrixReport, type TestApp } from "./index";

const contract = defineContract("noteService", {
  methods: {
    read: query({ input: z.object({ id: z.string() }), output: z.null() }),
    write: mutation({ input: z.object({ id: z.string(), text: z.string() }), output: z.null() }),
  },
});
const qd = initQuickdraw();
const service = qd.defineService(contract, {
  methods: {
    read: { access: "public", handler: () => null },
    write: { access: "authenticated", handler: () => null },
  },
});

declare const app: TestApp<readonly [typeof service]>;
declare const alice: Principal;

describe("describeAccessMatrix", () => {
  test("types each case by the contract and the principals' names", () => {
    expectTypeOf(
      describeAccessMatrix(app, {
        service,
        principals: { alice },
        cases: [
          { method: "read", input: { id: "n1" }, allow: ["alice", "anonymous"] },
          { method: "write", input: { id: "n1", text: "x" }, expect: { anonymous: "deny" } },
        ],
      }),
    ).resolves.toEqualTypeOf<AccessMatrixReport>();
  });

  test("refuses a name, a method or an input the matrix does not have", () => {
    void describeAccessMatrix(app, {
      service,
      principals: { alice },
      // @ts-expect-error -- bob is not one of the principals
      cases: [{ method: "read", input: { id: "n1" }, allow: ["bob"] }],
    });
    void describeAccessMatrix(app, {
      service,
      principals: { alice },
      // @ts-expect-error -- noteService has no method "delete"
      cases: [{ method: "delete", input: { id: "n1" } }],
    });
    void describeAccessMatrix(app, {
      service,
      principals: { alice },
      // @ts-expect-error -- write needs text
      cases: [{ method: "write", input: { id: "n1" } }],
    });
    void describeAccessMatrix(app, {
      service,
      principals: { alice },
      // @ts-expect-error -- "maybe" is not an outcome
      cases: [{ method: "read", input: { id: "n1" }, expect: { alice: "maybe" } }],
    });
  });
});
