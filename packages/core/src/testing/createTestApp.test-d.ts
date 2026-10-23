// Type tests for the test app's in-process caller: `app.as(principal,
// options)` takes the transports an in-process call can arrive as, and its
// `mcp` is typed by the app's declared MCP fields, the type `ctx.mcp` gets.

import { describe, expectTypeOf, test } from "vitest";
import { z } from "zod";
import { defineContract, query } from "../index";
import { initQuickdraw, type McpContext, type Principal } from "../server/index";
import type { TestApp, TestCallerOptions } from "./index";

const contract = defineContract("noteService", {
  methods: { read: query({ input: z.undefined(), output: z.null() }) },
});

/** The MCP fields one app declares: the scopes of an agent's token. */
interface TokenFields {
  readonly scopes: readonly string[];
}

const methods = { read: { access: "public", handler: () => null } } as const;
const declared = initQuickdraw<{ principal: Principal; mcp: TokenFields }>();
const declaredService = declared.defineService(contract, { methods });
const undeclaredService = initQuickdraw().defineService(contract, { methods });

declare const app: TestApp<readonly [typeof declaredService]>;
declare const plainApp: TestApp<readonly [typeof undeclaredService]>;
declare const alice: Principal;

describe("app.as", () => {
  test("types mcp by the app's declared MCP fields", () => {
    expectTypeOf<Parameters<typeof app.as>[1]>().toEqualTypeOf<
      TestCallerOptions<TokenFields> | undefined
    >();
    void app.as(alice, { transport: "mcp", mcp: { scopes: ["read"] } });
    // @ts-expect-error a field the app does not declare
    void app.as(alice, { mcp: { token: "t" } });
    // @ts-expect-error the scopes are strings
    void app.as(alice, { mcp: { scopes: [1] } });
  });

  test("types mcp as McpContext when the app declares none", () => {
    expectTypeOf<NonNullable<Parameters<typeof plainApp.as>[1]>["mcp"]>().toEqualTypeOf<
      McpContext | undefined
    >();
    void plainApp.as(alice, { transport: "mcp", mcp: { token: "t" } });
  });

  test("takes the transports of an in-process call, and still takes the principal alone", () => {
    expectTypeOf<NonNullable<Parameters<typeof app.as>[1]>["transport"]>().toEqualTypeOf<
      "internal" | "http" | "mcp" | undefined
    >();
    void app.as(null);
    void app.as(alice, { transport: "http" });
    // @ts-expect-error a socket's call is app.connect's
    void app.as(alice, { transport: "socket" });
  });
});
