// Type tests for the search kit (RFC 0003 section 12.2). `bun run
// typecheck` checks this file, and vitest's typecheck mode reports each
// block as a test. Each `@ts-expect-error` sits on the line the compiler
// reports, so a rule that stops failing breaks the typecheck.

import { describe, expectTypeOf, test } from "vitest";
import { z } from "zod";
import { createQuickdrawClient } from "../../../client/index";
import {
  defineContract,
  query,
  type InputOf,
  type OutputOf,
  type ParsedInputOf,
  type SearchPage,
} from "../../../index";
import { createMockClient } from "../../../testing/client";
import { inherit, initQuickdraw, search, type Principal } from "../../index";

const task = z.object({
  id: z.string(),
  projectId: z.string(),
  title: z.string(),
  status: z.enum(["open", "done"]),
  ordinal: z.number(),
  notes: z.string().nullable(),
  tags: z.array(z.string()),
});
const card = task.pick({ id: true, projectId: true, title: true });

type TaskRow = z.output<typeof task>;
type CardRow = z.output<typeof card>;

const project = defineContract("projectService", {
  entity: z.object({ id: z.string(), name: z.string() }),
});

const taskContract = defineContract("taskService", {
  entity: task,
  projections: { card },
  methods: {
    ...search.contract({ entity: task, item: card, fields: ["title"], scope: "byProject" }),
    findAll: search.contract({ entity: task, fields: ["title", "notes", "status"] }).search,
    get: query({ input: z.object({ id: z.string() }), output: "entity" }),
  },
  collections: {
    byProject: { scope: "projectId", item: "card", order: [["id", "asc"]] },
  },
});

interface Db {
  readonly task: { findUnique(args: object): Promise<TaskRow> };
}

const qd = initQuickdraw<{ db: Db; principal: Principal }>();

describe("search.contract", () => {
  test("types the input and the page from the entity and the options", () => {
    expectTypeOf<OutputOf<typeof taskContract, "search">>().toEqualTypeOf<SearchPage<CardRow>>();
    expectTypeOf<OutputOf<typeof taskContract, "findAll">>().toEqualTypeOf<SearchPage<TaskRow>>();
    expectTypeOf<InputOf<typeof taskContract, "search">>().toMatchTypeOf<{
      readonly q: string;
      readonly scope?: string;
      readonly cursor?: string;
      readonly limit?: number;
    }>();
    expectTypeOf<keyof InputOf<typeof taskContract, "findAll">>().toEqualTypeOf<
      "q" | "cursor" | "limit"
    >();
    expectTypeOf<ParsedInputOf<typeof taskContract, "search">>().toEqualTypeOf<{
      readonly q: string;
      readonly scope: string | undefined;
      readonly cursor: string | undefined;
      readonly limit: number;
    }>();
  });

  test("searches only the entity's text fields", () => {
    search.contract({
      entity: task,
      // @ts-expect-error ordinal holds numbers
      fields: ["title", "ordinal"],
    });
    search.contract({
      entity: task,
      // @ts-expect-error nope is not a field of the entity
      fields: ["nope"],
    });
  });
});

describe("search.handlers", () => {
  test("implements the search methods inside defineService, beside hand-written ones", () => {
    const service = qd.defineService(taskContract, {
      model: "task",
      access: inherit({ from: project, via: "projectId" }),
      collections: { byProject: { anchor: project } },
      methods: {
        ...search.handlers(taskContract, {
          access: "authenticated",
          strategy: {
            where: (q, ctx) => {
              expectTypeOf(ctx.principal).toEqualTypeOf<Principal>();
              expectTypeOf(ctx.signal).toEqualTypeOf<AbortSignal>();
              return { title: { contains: q } };
            },
          },
        }),
        get: {
          access: { entry: "Read" },
          handler: ({ input, db }) => db.task.findUnique({ where: { id: input.id } }),
        },
      },
    });
    expectTypeOf(service.contract).toEqualTypeOf<typeof taskContract>();
  });

  test("a public search's strategy may have no principal; ids gets the page size", () => {
    search.handlers(taskContract, {
      access: "public",
      strategy: {
        ids: (_q, ctx, { limit }) => {
          expectTypeOf(ctx.principal).toEqualTypeOf<Principal | null>();
          expectTypeOf(limit).toBeNumber();
          return [];
        },
      },
    });
  });

  test("a strategy is where or ids, not both", () => {
    search.handlers(taskContract, {
      access: "public",
      // @ts-expect-error where and ids together
      strategy: { where: () => ({}), ids: () => [] },
    });
  });

  test("method names one search method, whose input its access form reads", () => {
    const one = search.handlers(taskContract, {
      method: "search",
      access: {
        scope: "Read",
        of: project,
        id: (input) => {
          expectTypeOf(input.scope).toEqualTypeOf<string | undefined>();
          return input.scope ?? "";
        },
      },
    });
    expectTypeOf<keyof typeof one>().toEqualTypeOf<"search">();
    // @ts-expect-error get is not a method search.contract made
    search.handlers(taskContract, { access: "public", method: "get" });
  });

  test("a contract without a search method does not compile", () => {
    const plain = defineContract("plainService", {
      entity: task,
      methods: { get: query({ input: z.object({ id: z.string() }), output: "entity" }) },
    });
    // @ts-expect-error plainService has no method search.contract made
    search.handlers(plain, { access: "public" });
  });
});

describe("useSearch", () => {
  const client = createQuickdrawClient({ task: taskContract });

  test("is on a search method's member, typed by its page", () => {
    expectTypeOf(client.task.search.useSearch("plan").items).toEqualTypeOf<readonly CardRow[]>();
    expectTypeOf(client.task.findAll.useSearch("plan").items).toEqualTypeOf<readonly TaskRow[]>();
    expectTypeOf(client.task.search.useSearch("plan").isSearching).toBeBoolean();
    client.task.search.useSearch("plan", { scope: "p1", debounceMs: 100, limit: 5 });
    // @ts-expect-error findAll keeps to no collection's scopes
    client.task.findAll.useSearch("plan", { scope: "p1" });
    // @ts-expect-error get is not a search
    expectTypeOf(client.task.get.useSearch).toBeFunction();
  });

  test("a mock client has the same member", () => {
    const mock = createMockClient({ task: taskContract });
    expectTypeOf(mock.task.search.useSearch("plan").items).toEqualTypeOf<readonly CardRow[]>();
    mock.task.search.mockResolvedValue({ items: [], nextCursor: null });
  });
});
