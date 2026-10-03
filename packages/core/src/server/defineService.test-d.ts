// Type tests for `defineService`, the handler argument and the in-process
// caller (RFC 0003 sections 3, 4.1 and 10). `bun run typecheck` checks this
// file, and vitest's typecheck mode reports each block as a test. Each
// `@ts-expect-error` sits on the line the compiler reports, so a rule that
// stops failing breaks the typecheck. The run-time checks for the same rules
// are in defineService.test.ts.

import { describe, expectTypeOf, test } from "vitest";
import { z } from "zod";
import { defineContract, listOf, mutation, nullable, query, type Version } from "../index";
import {
  createDispatcher,
  custom,
  initQuickdraw,
  type AnyService,
  type BaseContext,
  type Caller,
  type HandlerContext,
  type Principal,
  type Service,
} from "./index";

const taskSchema = z.object({
  id: z.string(),
  projectId: z.string(),
  title: z.string(),
  done: z.boolean(),
});
const cardSchema = taskSchema.pick({ id: true, title: true });

const task = defineContract("taskService", {
  entity: taskSchema,
  projections: { card: cardSchema },
  methods: {
    get: query({ input: z.object({ id: z.string() }), output: "entity" }),
    find: query({ input: z.object({ id: z.string() }), output: nullable("entity") }),
    list: query({
      input: z.object({ projectId: z.string(), limit: z.number().int().default(20) }),
      output: listOf("card"),
    }),
    count: query({ input: z.object({ projectId: z.string() }), output: z.number() }),
    rename: mutation({ input: z.object({ id: z.string(), title: z.string() }), output: "entity" }),
    ping: query({ input: z.undefined(), output: z.literal("pong") }),
  },
});

const project = defineContract("projectService", {
  entity: z.object({ id: z.string(), name: z.string() }),
  methods: { get: query({ input: z.object({ id: z.string() }), output: "entity" }) },
});

type TaskRow = z.output<typeof taskSchema>;
type CardRow = z.output<typeof cardSchema>;

interface AppPrincipal extends Principal {
  readonly kind: "user" | "agent";
  readonly email: string;
}

interface Db {
  readonly task: { find(id: string): Promise<TaskRow> };
}

declare const database: Db;
declare const row: TaskRow;
declare const user: AppPrincipal;

const qd = initQuickdraw<{ db: Db; principal: AppPrincipal; contracts: { task: typeof task } }>();

// ---------------------------------------------------------------------------
// The example service: a query, a mutation, an entry-access method and a
// custom-access method.
// ---------------------------------------------------------------------------

const taskService = qd.defineService(task, {
  methods: {
    get: {
      access: "public",
      handler: ({ input, db }) => db.task.find(input.id),
    },
    find: {
      access: "authenticated",
      share: "caller",
      handler: async ({ input, ctx, db }) =>
        ctx.principal.kind === "agent" ? null : await db.task.find(input.id),
    },
    list: {
      access: { entry: "Read", id: "projectId" },
      share: "all",
      ttlMs: 500,
      handler: ({ input }) =>
        Array.from({ length: input.limit }, (_, i) => ({ id: `${i}`, title: "t" })),
    },
    count: {
      access: custom(
        (ctx, input) => ctx.principal.email.endsWith("@example.com") && input.projectId !== "",
      ),
      version: (input) => `${input.projectId}:1`,
      handler: () => 3,
    },
    rename: {
      access: { service: "Moderate", entry: "Moderate" },
      timeoutMs: 5_000,
      handler: async ({ input, db }) => ({ ...(await db.task.find(input.id)), title: input.title }),
    },
    ping: { access: "public", handler: () => "pong" as const },
  },
});

describe("defineService", () => {
  test("returns a service typed by the app and its contract", () => {
    expectTypeOf(taskService.name).toEqualTypeOf<"taskService">();
    expectTypeOf(taskService.contract).toEqualTypeOf<typeof task>();
    expectTypeOf(taskService).toExtend<AnyService>();
  });

  test("a handler receives the parsed input, the app's db and a typed ctx", () => {
    qd.defineService(task, {
      methods: {
        get: { access: "public", handler: ({ db }) => db.task.find("t1") },
        find: { access: "public", handler: () => null },
        list: {
          access: "authenticated",
          handler: ({ input, ctx, db }) => {
            expectTypeOf(input).toEqualTypeOf<{ projectId: string; limit: number }>();
            expectTypeOf(db).toEqualTypeOf<Db>();
            expectTypeOf(ctx.principal).toEqualTypeOf<AppPrincipal>();
            expectTypeOf(ctx.signal).toEqualTypeOf<AbortSignal>();
            expectTypeOf(ctx.requestId).toBeString();
            expectTypeOf(ctx.transport).toEqualTypeOf<
              "socket" | "http" | "mcp" | "internal" | "legacy"
            >();
            expectTypeOf(ctx.touch).parameter(1).toEqualTypeOf<string | readonly string[]>();
            return [];
          },
        },
        count: { access: "public", handler: () => 0 },
        rename: { access: { entry: "Moderate" }, handler: () => row },
        ping: { access: "public", handler: () => "pong" },
      },
    });
  });

  test('ctx.principal is nullable under "public" access only', () => {
    qd.defineService(task, {
      methods: {
        get: {
          access: "public",
          handler: ({ ctx }) => {
            expectTypeOf(ctx.principal).toEqualTypeOf<AppPrincipal | null>();
            return row;
          },
        },
        find: {
          access: { service: "Read" },
          handler: ({ ctx }) => {
            expectTypeOf(ctx.principal).toEqualTypeOf<AppPrincipal>();
            return null;
          },
        },
        list: {
          access: { scope: "Read", of: project, id: "projectId" },
          handler: ({ ctx }) => {
            expectTypeOf(ctx.principal).toEqualTypeOf<AppPrincipal>();
            return [];
          },
        },
        count: {
          access: custom((ctx) => ctx.principal.kind === "user"),
          handler: ({ ctx }) => {
            expectTypeOf(ctx.principal).toEqualTypeOf<AppPrincipal>();
            return 1;
          },
        },
        rename: {
          access: { entry: "Moderate" },
          handler: ({ ctx }) => {
            expectTypeOf(ctx.principal).toEqualTypeOf<AppPrincipal>();
            return row;
          },
        },
        ping: {
          access: "public",
          // @ts-expect-error -- a "public" handler cannot assume a principal
          handler: ({ ctx }) => (ctx.principal.userId === "" ? "pong" : "pong"),
        },
      },
    });
  });

  test("custom checks and versions are typed by the method's input and the app's ctx", () => {
    custom<{ projectId: string }, HandlerContext<{ principal: AppPrincipal }>>((ctx, input) => {
      expectTypeOf(ctx.principal).toEqualTypeOf<AppPrincipal>();
      expectTypeOf(input).toEqualTypeOf<{ projectId: string }>();
      return true;
    });
    qd.defineService(task, {
      methods: {
        get: { access: "public", handler: () => row },
        find: { access: "public", handler: () => null },
        list: { access: "public", handler: () => [] },
        count: {
          access: custom((ctx, input) => {
            expectTypeOf(input).toEqualTypeOf<{ projectId: string }>();
            expectTypeOf(ctx.principal).toEqualTypeOf<AppPrincipal>();
            return Promise.resolve(true);
          }),
          version: (input, ctx) => {
            expectTypeOf(input).toEqualTypeOf<{ projectId: string }>();
            expectTypeOf(ctx.principal).toEqualTypeOf<AppPrincipal>();
            return 1;
          },
          handler: () => 0,
        },
        rename: { access: "authenticated", handler: () => row },
        ping: { access: "public", handler: () => "pong" },
      },
    });
  });

  test("a projection output accepts a row; nullable and listOf wrap it", () => {
    // A database row may carry more columns than the projection names.
    const wideRow = { ...row, createdBy: "u1" };
    qd.defineService(task, {
      methods: {
        get: { access: "public", handler: () => wideRow },
        find: { access: "public", handler: () => Promise.resolve(null) },
        list: { access: "public", handler: (): CardRow[] => [{ id: "t1", title: "a card" }] },
        count: { access: "public", handler: () => 42 },
        rename: { access: "authenticated", handler: () => Promise.resolve(row) },
        ping: { access: "public", handler: () => "pong" },
      },
    });
  });
});

// ---------------------------------------------------------------------------
// Definitions that fail to compile.
// ---------------------------------------------------------------------------

const ok = {
  get: { access: "public", handler: () => row },
  find: { access: "public", handler: () => null },
  list: { access: "public", handler: () => [] },
  count: { access: "public", handler: () => 0 },
  rename: { access: "authenticated", handler: () => row },
  ping: { access: "public", handler: () => "pong" as const },
} as const;

describe("definitions that fail to compile", () => {
  test("a missing method", () => {
    qd.defineService(task, {
      // @ts-expect-error -- "ping" has no implementation
      methods: {
        get: ok.get,
        find: ok.find,
        list: ok.list,
        count: ok.count,
        rename: ok.rename,
      },
    });
  });

  test("a method the contract does not declare", () => {
    qd.defineService(task, {
      methods: {
        ...ok,
        // @ts-expect-error -- "archive" is not a method of taskService
        archive: { access: "authenticated", handler: () => row },
      },
    });
  });

  test("a method without access", () => {
    qd.defineService(task, {
      methods: {
        ...ok,
        // @ts-expect-error -- access is required
        count: { handler: () => 0 },
      },
    });
  });

  test("a handler that returns the wrong type", () => {
    qd.defineService(task, {
      methods: {
        ...ok,
        // @ts-expect-error -- count returns a number, not a string
        count: { access: "public", handler: () => "three" },
      },
    });
    qd.defineService(task, {
      methods: {
        ...ok,
        // @ts-expect-error -- get returns a whole task, not a card
        get: { access: "public", handler: () => ({ id: "t1", title: "a card" }) },
      },
    });
    qd.defineService(task, {
      methods: {
        ...ok,
        // @ts-expect-error -- get is not nullable
        get: { access: "public", handler: () => null },
      },
    });
  });

  test("entry access without an id, on an input without one", () => {
    qd.defineService(task, {
      methods: {
        ...ok,
        // @ts-expect-error -- list's input has no id, so entry access must name one
        list: { access: { entry: "Read" }, handler: () => [] },
      },
    });
    qd.defineService(task, {
      methods: {
        ...ok,
        // @ts-expect-error -- limit is a number, so it cannot hold a row id
        list: { access: { entry: "Read", id: "limit" }, handler: () => [] },
      },
    });
    qd.defineService(task, {
      methods: {
        ...ok,
        list: { access: { entry: "Read", id: (input) => input.projectId }, handler: () => [] },
        rename: { access: { entry: "Moderate" }, handler: () => row },
      },
    });
  });

  test("forms that do not exist", () => {
    qd.defineService(task, {
      methods: {
        ...ok,
        // @ts-expect-error -- "Owner" is not an access level
        count: { access: { service: "Owner" }, handler: () => 0 },
      },
    });
    qd.defineService(task, {
      methods: {
        ...ok,
        // @ts-expect-error -- a scope form needs the other service's contract
        list: { access: { scope: "Read", id: "projectId" }, handler: () => [] },
      },
    });
    qd.defineService(task, {
      methods: {
        ...ok,
        // @ts-expect-error -- "anyone" is not an access form
        count: { access: "anyone", handler: () => 0 },
      },
    });
  });

  test("share, ttlMs and version belong to queries, and custom access cannot share with all", () => {
    qd.defineService(task, {
      methods: {
        ...ok,
        // @ts-expect-error -- a mutation cannot share
        rename: { access: "authenticated", share: "caller", handler: () => row },
      },
    });
    qd.defineService(task, {
      methods: {
        ...ok,
        // @ts-expect-error -- a mutation has no version
        rename: { access: "authenticated", version: () => 1, handler: () => row },
      },
    });
    qd.defineService(task, {
      methods: {
        ...ok,
        count: {
          access: custom(() => true),
          // @ts-expect-error -- a custom check may depend on who asks, so its result is not shared with all
          share: "all",
          handler: () => 0,
        },
      },
    });
    qd.defineService(task, {
      methods: {
        ...ok,
        // @ts-expect-error -- a result that is not shared is never kept, so ttlMs needs share
        count: { access: "public", ttlMs: 500, handler: () => 0 },
      },
    });
    qd.defineService(task, {
      methods: {
        ...ok,
        count: { access: "public", share: "caller", ttlMs: 500, handler: () => 0 },
      },
    });
  });

  test("an unknown option", () => {
    qd.defineService(task, {
      methods: {
        ...ok,
        // @ts-expect-error -- "cache" is not a method option
        count: { access: "public", cache: true, handler: () => 0 },
      },
    });
  });
});

// ---------------------------------------------------------------------------
// The app's context extension, and the init options it requires.
// ---------------------------------------------------------------------------

describe("initQuickdraw", () => {
  test("context adds the app's fields to every handler's ctx", () => {
    const withTenant = initQuickdraw<{
      db: Db;
      principal: AppPrincipal;
      context: { tenant: string };
    }>({
      context: (base) => {
        expectTypeOf(base).toEqualTypeOf<BaseContext<AppPrincipal | null>>();
        return { tenant: base.principal?.email ?? "anonymous" };
      },
    });
    withTenant.defineService(project, {
      methods: {
        get: {
          access: "authenticated",
          handler: ({ ctx, input }) => {
            expectTypeOf(ctx.tenant).toBeString();
            return { id: input.id, name: ctx.tenant };
          },
        },
      },
    });
  });

  test("context is required when the app's types declare it, and must return those fields", () => {
    // @ts-expect-error -- the types declare a context, so the option is required
    initQuickdraw<{ context: { tenant: string } }>();
    // @ts-expect-error -- the context must return a tenant
    initQuickdraw<{ context: { tenant: string } }>({ context: () => ({}) });
    initQuickdraw();
    initQuickdraw<{ db: Db }>({});
  });
});

// ---------------------------------------------------------------------------
// The dispatcher and the in-process caller.
// ---------------------------------------------------------------------------

describe("the in-process caller", () => {
  const projectService = qd.defineService(project, {
    methods: {
      get: { access: "authenticated", handler: ({ input }) => ({ id: input.id, name: "p" }) },
    },
  });
  const dispatcher = qd.createDispatcher({ services: [taskService, projectService], db: database });

  test("is typed by the contracts the services were defined from", () => {
    const caller = dispatcher.caller(user);
    expectTypeOf(caller.taskService.rename)
      .parameter(0)
      .toEqualTypeOf<{ id: string; title: string }>();
    expectTypeOf(caller.taskService.rename).returns.resolves.toEqualTypeOf<TaskRow>();
    expectTypeOf(caller.taskService.list)
      .parameter(0)
      .toEqualTypeOf<{ projectId: string; limit?: number }>();
    expectTypeOf(caller.taskService.list).returns.resolves.toEqualTypeOf<CardRow[]>();
    expectTypeOf(caller.taskService.find).returns.resolves.toEqualTypeOf<TaskRow | null>();
    expectTypeOf(caller.projectService.get).returns.resolves.toEqualTypeOf<{
      id: string;
      name: string;
    }>();
    expectTypeOf(caller).toEqualTypeOf<Caller<typeof task | typeof project>>();
  });

  test("leaves out an input the method does not need, and rejects a wrong one", () => {
    const caller = dispatcher.caller(null);
    expectTypeOf(caller.taskService.ping).toBeCallableWith();
    expectTypeOf(caller.taskService.ping).returns.resolves.toEqualTypeOf<"pong">();
    // @ts-expect-error -- rename needs an id and a title
    void caller.taskService.rename({ id: "t1" });
    // @ts-expect-error -- the dispatcher serves no chatService
    void caller.chatService;
  });

  test("qd.caller is typed by the app's contracts, or untyped without them", () => {
    expectTypeOf(qd.caller(user).taskService.get).returns.resolves.toEqualTypeOf<TaskRow>();
    // @ts-expect-error -- the app's contracts declare no projectService
    void qd.caller(user).projectService;
    const untyped = initQuickdraw().caller(null);
    expectTypeOf(untyped.anything?.method).toEqualTypeOf<
      | ((input?: unknown, options?: { readonly signal?: AbortSignal }) => Promise<unknown>)
      | undefined
    >();
  });

  test("the db must match the services' types, and may be left out when they declare none", () => {
    // @ts-expect-error -- db is not the app's database client
    qd.createDispatcher({ services: [taskService], db: { task: null } });
    // @ts-expect-error -- the services declare a db, so it is required
    createDispatcher({ services: [taskService] });
    const bare = initQuickdraw();
    const service: Service = bare.defineService(project, {
      methods: { get: { access: "public", handler: ({ input }) => ({ id: input.id, name: "" }) } },
    });
    createDispatcher({ services: [service] });
  });

  test("a version is a number or a string", () => {
    expectTypeOf<Version>().toEqualTypeOf<number | string>();
  });
});
