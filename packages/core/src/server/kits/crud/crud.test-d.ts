// Type tests for the read/write kit (RFC 0003 section 12.1). `bun run
// typecheck` checks this file, and vitest's typecheck mode reports each
// block as a test. Each `@ts-expect-error` sits on the line the compiler
// reports, so a rule that stops failing breaks the typecheck.

import { describe, expectTypeOf, test } from "vitest";
import { z } from "zod";
import { createQuickdrawClient } from "../../../client/index";
import {
  defineContract,
  mutation,
  type InputOf,
  type ListPage,
  type OutputOf,
  type ParsedInputOf,
} from "../../../index";
import { crud, custom, inherit, initQuickdraw, nextOrdinal, type Principal } from "../../index";

const task = z.object({
  id: z.string(),
  projectId: z.string(),
  title: z.string(),
  status: z.enum(["open", "done"]),
  ordinal: z.number(),
  assigneeId: z.string().nullable(),
  tags: z.array(z.string()),
});
const card = task.pick({ id: true, title: true, ordinal: true });
const patch = task.pick({ title: true, status: true }).partial();

type TaskRow = z.output<typeof task>;
type CardRow = z.output<typeof card>;

const kit = crud.contract({
  entity: task,
  get: true,
  getMany: true,
  list: { item: card, filter: ["projectId", "assigneeId"], sort: ["ordinal"] },
  create: { input: task.pick({ projectId: true, title: true }) },
  update: { input: patch },
  delete: true,
  reorder: { column: "ordinal", within: "projectId" },
  bulkUpdate: { input: patch },
});

const taskContract = defineContract("taskService", {
  entity: task,
  projections: { card },
  methods: {
    ...kit,
    archive: mutation({ input: z.object({ id: z.string() }), output: "entity" }),
  },
});

const project = defineContract("projectService", {
  entity: z.object({ id: z.string(), name: z.string() }),
});

interface Db {
  readonly task: { update(args: object): Promise<TaskRow> };
}

const qd = initQuickdraw<{ db: Db; principal: Principal }>();
const policy = { model: "task", access: inherit({ from: project, via: "projectId" }) } as const;

const access = {
  get: { entry: "Read" },
  getMany: "authenticated",
  list: "authenticated",
  create: { scope: "Moderate", of: project, id: "projectId" },
  update: { entry: "Moderate" },
  delete: { entry: "Admin" },
  reorder: { entry: "Moderate" },
  bulkUpdate: "authenticated",
} as const;

describe("crud.contract", () => {
  test("types each method's input and output from the entity and the options", () => {
    expectTypeOf<OutputOf<typeof taskContract, "get">>().toEqualTypeOf<TaskRow>();
    expectTypeOf<OutputOf<typeof taskContract, "getMany">>().toEqualTypeOf<TaskRow[]>();
    expectTypeOf<OutputOf<typeof taskContract, "list">>().toEqualTypeOf<ListPage<CardRow>>();
    expectTypeOf<InputOf<typeof taskContract, "list">>().toEqualTypeOf<
      | {
          readonly filter?: {
            readonly projectId?: string;
            readonly assigneeId?: string | null;
          };
          readonly sort?: { readonly field: "ordinal"; readonly direction?: "asc" | "desc" };
          readonly cursor?: string;
          readonly limit?: number;
          readonly totalCount?: boolean;
        }
      | undefined
    >();
    expectTypeOf<ParsedInputOf<typeof taskContract, "list">["limit"]>().toEqualTypeOf<number>();
    expectTypeOf<InputOf<typeof taskContract, "update">>().toEqualTypeOf<
      { readonly id: string } & { title?: string; status?: "open" | "done" }
    >();
    expectTypeOf<InputOf<typeof taskContract, "bulkUpdate">>().toEqualTypeOf<{
      readonly ids: readonly string[];
      readonly data: { title?: string; status?: "open" | "done" };
    }>();
    expectTypeOf<OutputOf<typeof taskContract, "bulkUpdate">>().toEqualTypeOf<{
      readonly count: number;
    }>();
    expectTypeOf<OutputOf<typeof taskContract, "delete">>().toEqualTypeOf<null>();
    expectTypeOf<InputOf<typeof taskContract, "reorder">>().toEqualTypeOf<{
      readonly id: string;
      readonly beforeId?: string;
      readonly afterId?: string;
    }>();
  });

  test("filters, sorts and orders only by entity fields of the right kind", () => {
    crud.contract({
      entity: task,
      // @ts-expect-error "nope" is not a field of the entity
      list: { filter: ["nope"] },
    });
    crud.contract({
      entity: task,
      // @ts-expect-error tags is a list, not a value to filter on
      list: { sort: ["tags"] },
    });
    crud.contract({
      entity: task,
      // @ts-expect-error a reorder column holds numbers
      reorder: { column: "title" },
    });
  });

  test("a method the options leave out has no client member", () => {
    const client = createQuickdrawClient({ taskService: taskContract });
    expectTypeOf(client.taskService.list.useQuery).toBeFunction();
    expectTypeOf(client.taskService.update.useMutation).toBeFunction();
    // @ts-expect-error bulkDelete was not turned on
    expectTypeOf(client.taskService.bulkDelete).toBeObject();
  });
});

describe("crud.handlers", () => {
  test("implements the kit's methods inside defineService, beside hand-written ones", () => {
    const service = qd.defineService(taskContract, {
      ...policy,
      methods: {
        ...crud.handlers(taskContract, {
          access: {
            ...access,
            bulkUpdate: custom((ctx, input) => {
              expectTypeOf(ctx.principal).toEqualTypeOf<Principal>();
              expectTypeOf(input.ids).toEqualTypeOf<string[]>();
              return input.ids.length < 10;
            }),
          },
          prepare: async (input, ctx, db) => {
            expectTypeOf(input).toEqualTypeOf<{ projectId: string; title: string }>();
            expectTypeOf(ctx.principal.userId).toBeString();
            return {
              ...input,
              ordinal: await nextOrdinal(db, "task", { projectId: input.projectId }),
            };
          },
        }),
        archive: {
          access: { entry: "Admin" },
          handler: ({ input, db }) => db.task.update({ where: { id: input.id } }),
        },
      },
    });
    expectTypeOf(service.contract).toEqualTypeOf<typeof taskContract>();
  });

  test("an enabled method without an access form does not compile", () => {
    const { reorder: _reorder, ...missing } = access;
    // @ts-expect-error reorder has no access form
    crud.handlers(taskContract, { access: missing });
  });

  test("a form for a method the kit did not make does not compile", () => {
    crud.handlers(taskContract, {
      // @ts-expect-error archive is a hand-written method
      access: { ...access, archive: "authenticated" },
    });
  });

  test("prepare's db is the app's client as annotated, checked against the service's; unknown unannotated", () => {
    qd.defineService(taskContract, {
      ...policy,
      methods: {
        ...crud.handlers(taskContract, {
          access,
          prepare: async (input, _ctx, db: Db) => {
            const row = await db.task.update({ where: { id: "t1" } });
            return { ...input, ordinal: row.ordinal + 1 };
          },
        }),
        archive: {
          access: { entry: "Admin" },
          handler: ({ input, db }) => db.task.update({ where: { id: input.id } }),
        },
      },
    });
    qd.defineService(taskContract, {
      ...policy,
      // @ts-expect-error -- prepare's db is not the app's client
      methods: {
        ...crud.handlers(taskContract, {
          access,
          prepare: (input, _ctx, db: { readonly other: true }) => ({ ...input, other: db.other }),
        }),
        archive: { access: { entry: "Admin" }, handler: () => Promise.resolve(null as never) },
      },
    });
    crud.handlers(taskContract, {
      access,
      prepare: (input, _ctx, db) => {
        expectTypeOf(db).toEqualTypeOf<unknown>();
        return input;
      },
    });
  });

  test("prepare exists only for a contract with the kit's create", () => {
    const reads = defineContract("readService", {
      entity: task,
      methods: { ...crud.contract({ entity: task, get: true }) },
    });
    crud.handlers(reads, {
      access: { get: "public" },
      // @ts-expect-error the contract has no create
      prepare: () => ({}),
    });
  });

  test("defineService still checks the forms against the service", () => {
    qd.defineService(taskContract, {
      model: "task",
      // @ts-expect-error entry access needs the service's access policy
      methods: {
        ...crud.handlers(taskContract, { access }),
        archive: { access: "authenticated", handler: ({ input, db }) => db.task.update(input) },
      },
    });
    qd.defineService(taskContract, {
      ...policy,
      // @ts-expect-error archive, a hand-written method, is not implemented
      methods: { ...crud.handlers(taskContract, { access }) },
    });
  });
});
