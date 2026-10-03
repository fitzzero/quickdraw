// `search.handlers` (RFC 0003 section 12.2): implementations for the search
// kit's methods of a contract, shared per caller, refused when the options,
// the contract or the service cannot work, and served as MCP tools like any
// method.

import { describe, expect, it } from "vitest";
import { z } from "zod";
import { defineContract, search as contractSearch } from "../../../index";
import { projectContract, qd } from "../../emit/__tests__/live";
import { describeTools } from "../../mcp/index";
import { inherit, search } from "../../index";
import { cardSchema, defineSearchService, searchContract } from "./__tests__/fixture";
import { taskEntity } from "../crud/__tests__/fixture";

const notes = defineContract("noteService", {
  entity: taskEntity,
  projections: { card: cardSchema },
  methods: { ...search.contract({ entity: taskEntity, fields: ["title"] }) },
});

describe("search.handlers", () => {
  it("implements every search method of the contract, shared per caller, or the one named", () => {
    const all = search.handlers(searchContract, { access: "authenticated" });
    expect(Object.keys(all)).toEqual(["search", "searchByLabel"]);
    expect(all.search).toMatchObject({ access: "authenticated", share: "caller" });
    expect(typeof all.search.handler).toBe("function");
    expect(Object.isFrozen(all)).toBe(true);
    const one = search.handlers(searchContract, { access: "public", method: "searchByLabel" });
    expect(Object.keys(one)).toEqual(["searchByLabel"]);
    // The server's search carries the contract half too.
    expect(search.contract).toBe(contractSearch.contract);
  });

  it("refuses malformed options, strategies and a method it did not make", () => {
    const refuse = (options: unknown) => () =>
      search.handlers(notes, options as { access: "authenticated" });
    expect(refuse({ access: "everyone" })).toThrow('search.handlers: access must be "public"');
    expect(refuse({ access: "public", extra: 1 })).toThrow('options has an unknown key "extra"');
    expect(refuse({ access: "public", strategy: {} })).toThrow(
      "strategy must be { where: (q, ctx) => filter } or { ids: (q, ctx, { limit }) => ids }",
    );
    expect(refuse({ access: "public", strategy: { where: () => ({}), ids: () => [] } })).toThrow(
      "strategy must be",
    );
    expect(refuse({ access: "public", strategy: { where: "title" } })).toThrow("strategy must be");
    expect(refuse({ access: "public", method: "get" })).toThrow(
      'method "get" is not a method search.contract made',
    );
    expect(() =>
      search.handlers({ name: "x", methods: {} } as never, { access: "public" }),
    ).toThrow("the first argument must be a contract from defineContract");
    const none = defineContract("noneService", { entity: taskEntity, methods: {} });
    expect(() => search.handlers(none as never, { access: "public" })).toThrow(
      "noneService has no method search.contract made",
    );
  });

  it("refuses a scope that is not a collection, and results that are not its items", () => {
    const kit = search.contract({ entity: taskEntity, fields: ["title"], scope: "board" });
    const noBoard = defineContract("aService", { entity: taskEntity, methods: { ...kit } });
    expect(() => search.handlers(noBoard, { access: "public" })).toThrow(
      'aService.search\'s scope "board" is not a collection of aService',
    );
    const otherItem = defineContract("bService", {
      entity: taskEntity,
      projections: { card: cardSchema },
      methods: { ...kit },
      collections: { board: { scope: "projectId", item: "card", order: [["id", "asc"]] } },
    });
    expect(() => search.handlers(otherItem, { access: "public" })).toThrow(
      'its item must be "card" (pass that projection\'s schema to search.contract as item), not "entity"',
    );
    const stray = z.object({ id: z.string(), title: z.string() });
    const strayItem = defineContract("cService", {
      entity: taskEntity,
      methods: {
        ...search.contract({ entity: taskEntity, item: stray, fields: ["title"] }),
      },
    });
    expect(() => search.handlers(strayItem, { access: "public" })).toThrow(
      "the item of cService.search must be its entity schema or one of its projections' schemas",
    );
  });
});

describe("defineService with search handlers", () => {
  it("refuses a service without a model, and handlers made for another contract", () => {
    expect(() =>
      qd.defineService(notes, {
        methods: { ...search.handlers(notes, { access: "authenticated" }) },
      }),
    ).toThrow(
      'defineService("noteService"): method "search": the search kit reads the service\'s rows: declare its model',
    );
    const twin = defineContract("noteService", {
      entity: taskEntity,
      projections: { card: cardSchema },
      methods: notes.methods,
    });
    expect(() =>
      qd.defineService(twin, {
        model: "task",
        access: inherit({ from: projectContract, via: "projectId" }),
        methods: search.handlers(notes, { access: "authenticated" }) as never,
      }),
    ).toThrow("its search kit handlers were made for another contract");
  });

  it("serves the search methods as read-only MCP tools, from the generated schemas", () => {
    const tools = describeTools([defineSearchService()]);
    expect(tools.map((tool) => [tool.name, tool.annotations?.readOnlyHint])).toEqual([
      ["taskService_search", true],
      ["taskService_searchByLabel", true],
    ]);
    expect(tools[0]?.inputSchema).toMatchObject({
      type: "object",
      required: ["q"],
      properties: { q: { type: "string" }, scope: { type: "string" } },
    });
    expect(tools[0]?.description).toContain("Searches the rows the caller can read");
  });
});
