import { describe, expect, it } from "vitest";
import { z } from "zod";
import { z as z3 } from "zod3";
import { via } from "./collections";
import { type AnyContract, defineContract } from "./defineContract";
import { listOf, mutation, nullable, query } from "./methods";

const taskSchema = z.object({
  id: z.string(),
  projectId: z.string(),
  title: z.string(),
  status: z.enum(["todo", "doing", "done"]),
  ordinal: z.number(),
  assigneeId: z.string().nullable(),
  internalNotes: z.string(),
  archived: z.boolean(),
});
const taskCardSchema = taskSchema.pick({
  id: true,
  title: true,
  status: true,
  ordinal: true,
  assigneeId: true,
});
const idInput = z.object({ id: z.string() });

/** The RFC 0003 section 2 sample contract. */
function defineTask() {
  return defineContract("taskService", {
    entity: taskSchema,
    projections: { card: taskCardSchema },
    fields: { internalNotes: "Admin" },
    methods: {
      get: query({ input: idInput, output: "entity" }),
      rename: mutation({
        input: z.object({ id: z.string(), title: z.string() }),
        output: "entity",
      }),
      stats: query({
        input: z.object({ projectId: z.string() }),
        output: z.object({ open: z.number() }),
        watch: { collection: "byProject", scope: (i) => i.projectId },
      }),
    },
    collections: {
      byProject: {
        scope: "projectId",
        item: "card",
        order: [
          ["ordinal", "asc"],
          ["id", "asc"],
        ],
        index: ["status", "ordinal", "assigneeId"],
        views: { mine: (row, who) => row.assigneeId === who.userId },
      },
    },
    streams: {},
    channels: {},
    events: {},
  });
}

/** `defineContract` with the types switched off, to reach the definition-time checks. */
const define = defineContract as unknown as (name: unknown, def: unknown) => AnyContract;

const entityOnly = { entity: taskSchema, projections: { card: taskCardSchema } };

/** A valid collection to vary one option at a time. */
const byProject = { scope: "projectId", item: "card", order: [["id", "asc"]] };

function withCollection(collection: Record<string, unknown>): () => AnyContract {
  return () =>
    define("taskService", { ...entityOnly, collections: { c: { ...byProject, ...collection } } });
}

function withMethod(method: unknown): () => AnyContract {
  return () => define("taskService", { ...entityOnly, methods: { m: method } });
}

describe("defineContract", () => {
  it("defines the RFC sample contract", () => {
    const task = defineTask();
    expect(task.name).toBe("taskService");
    expect(task.entity).toBe(taskSchema);
    expect(task.projections).toEqual({ card: taskCardSchema });
    expect(task.fields).toEqual({ internalNotes: "Admin" });
    expect(task.methods.get).toEqual({ kind: "query", input: idInput, output: "entity" });
    expect(task.methods.rename.kind).toBe("mutation");
    expect(task.methods.stats.watch?.collection).toBe("byProject");
    expect(task.methods.stats.watch?.scope({ projectId: "p1" })).toBe("p1");
    expect(task.collections.byProject.item).toBe("card");
    expect(task.collections.byProject.order).toEqual([
      ["ordinal", "asc"],
      ["id", "asc"],
    ]);
    expect(task.streams).toEqual({});
    expect(task.channels).toEqual({});
    expect(task.events).toEqual({});
  });

  it("keeps views as predicates over index rows", () => {
    const { mine } = defineTask().collections.byProject.views;
    const row = { id: "t1", status: "todo", ordinal: 1, assigneeId: "u1" } as const;
    expect(mine(row, { userId: "u1" })).toBe(true);
    expect(mine(row, { userId: "u2" })).toBe(false);
  });

  it("freezes the contract but not the schemas", () => {
    const task = defineTask();
    expect(Object.isFrozen(task)).toBe(true);
    expect(Object.isFrozen(task.methods)).toBe(true);
    expect(Object.isFrozen(task.methods.get)).toBe(true);
    expect(Object.isFrozen(task.collections)).toBe(true);
    expect(Object.isFrozen(task.collections.byProject)).toBe(true);
    expect(Object.isFrozen(taskSchema)).toBe(false);
  });

  it("fills absent members for a service without an entity", () => {
    const search = defineContract("searchService", {
      methods: {
        search: query({ input: z.object({ q: z.string() }), output: z.array(z.string()) }),
      },
    });
    expect(search.entity).toBeUndefined();
    expect(search.projections).toEqual({});
    expect(search.fields).toEqual({});
    expect(search.collections).toEqual({});
    expect(Object.keys(search.methods)).toEqual(["search"]);
  });

  it("accepts Zod 3.25 schemas", () => {
    const chat = z3.object({ id: z3.string(), ownerId: z3.string(), title: z3.string() });
    const contract = defineContract("chatService", {
      entity: chat,
      projections: { lean: chat.pick({ id: true, title: true }) },
      methods: {
        rename: mutation({ input: chat.pick({ id: true, title: true }), output: "lean" }),
      },
      collections: {
        mine: { scope: "ownerId", item: "lean", order: [["id", "asc"]], index: ["title"] },
      },
      streams: { typing: { item: z3.object({ userId: z3.string() }) } },
    });
    expect(contract.entity).toBe(chat);
    expect(contract.collections.mine.index).toEqual(["title"]);
  });

  it("accepts a via scope, a where filter, limits and an access level", () => {
    const contract = withCollection({
      scope: via({ model: "taskAssignee", entry: "taskId", scope: "userId" }),
      where: { archived: false, assigneeId: null },
      limit: 50,
      maxLimit: 200,
      access: "Moderate",
    })();
    expect(contract.collections.c?.scope).toEqual({
      kind: "via",
      model: "taskAssignee",
      entry: "taskId",
      scope: "userId",
    });
  });
});

describe("the method and collection builders", () => {
  it("return frozen plain data", () => {
    const watched = query({
      input: idInput,
      output: listOf("card"),
      watch: { collection: "byProject", scope: (i) => i.id },
    });
    expect(watched).toMatchObject({ kind: "query", output: { kind: "list", projection: "card" } });
    expect(query({ input: idInput, output: "entity" })).not.toHaveProperty("watch");
    expect(mutation({ input: idInput, output: nullable("entity") })).toEqual({
      kind: "mutation",
      input: idInput,
      output: { kind: "nullable", projection: "entity" },
    });
    expect(
      Object.isFrozen(watched) && Object.isFrozen(via({ model: "m", entry: "e", scope: "s" })),
    ).toBe(true);
  });

  it("keep a describe text, and leave it out when there is none", () => {
    const described = query({ input: idInput, output: "entity", describe: "Reads one task." });
    expect(described).toEqual({
      kind: "query",
      input: idInput,
      output: "entity",
      describe: "Reads one task.",
    });
    expect(mutation({ input: idInput, output: "entity", describe: "Renames a task." })).toEqual({
      kind: "mutation",
      input: idInput,
      output: "entity",
      describe: "Renames a task.",
    });
    expect(mutation({ input: idInput, output: "entity" })).not.toHaveProperty("describe");
    const contract = define("taskService", { ...entityOnly, methods: { get: described } });
    expect(contract.methods.get?.describe).toBe("Reads one task.");
    expect(Object.isFrozen(described)).toBe(true);
  });
});

describe("definition-time checks", () => {
  it.each([
    "subscribe",
    "unsubscribe",
    "call",
    "useEntity",
    "useEntities",
    "admin",
    "then",
    "$internal",
  ])("rejects the reserved method name %s, naming the method", (name) => {
    const defineReserved = (): AnyContract =>
      define("taskService", {
        ...entityOnly,
        methods: { [name]: query({ input: idInput, output: "entity" }) },
      });
    expect(defineReserved).toThrow(
      `defineContract("taskService"): method "${name}" uses a reserved name`,
    );
  });

  it("rejects a collection item that is not a projection", () => {
    expect(withCollection({ item: "summary" })).toThrow(
      'collection "c": item "summary" is not a projection; the projections are "card", "entity"',
    );
  });

  it("rejects a method output that names an unknown projection", () => {
    for (const output of ["summary", nullable("summary"), listOf("summary")]) {
      expect(withMethod(query({ input: idInput, output }))).toThrow(
        'method "m" returns unknown projection "summary"',
      );
    }
    expect(
      withMethod({ kind: "query", input: idInput, output: { kind: "page", projection: "card" } }),
    ).toThrow(
      'method "m": output must be a Standard Schema, a projection name, nullable(...) or listOf(...)',
    );
  });

  it("rejects an order that does not end with id", () => {
    expect(withCollection({ order: [["ordinal", "asc"]] })).toThrow(
      'collection "c": order must end with "id"',
    );
    for (const order of [[], [["id", "up"]], [["id"]], "id", undefined]) {
      expect(withCollection({ order })).toThrow('collection "c": order must be a list of');
    }
  });

  it("rejects a watch on an unknown collection, a mutation that watches, and a watch without scope", () => {
    const watch = { collection: "byOwner", scope: () => "x" };
    expect(withMethod(query({ input: idInput, output: "entity", watch }))).toThrow(
      'method "m" watches unknown collection "byOwner"; the collections are none',
    );
    expect(withMethod({ kind: "mutation", input: idInput, output: "entity", watch })).toThrow(
      'method "m" is a mutation; only a query can watch',
    );
    expect(
      withMethod({ kind: "query", input: idInput, output: "entity", watch: { collection: "c" } }),
    ).toThrow('method "m": watch must be { collection, scope } with a scope function');
  });

  it("rejects methods that are not query or mutation declarations", () => {
    expect(withMethod({ input: idInput, output: "entity" })).toThrow(
      'method "m" must be declared with query(...) or mutation(...)',
    );
    expect(withMethod({ kind: "query", input: { id: "string" }, output: "entity" })).toThrow(
      'method "m": input must be a Standard Schema',
    );
    expect(withMethod({ kind: "query", input: idInput, output: "entity", cache: true })).toThrow(
      'method "m" has an unknown option "cache"',
    );
  });

  it("rejects a describe text that is not a non-empty string", () => {
    for (const text of ["", 42, ["Reads"]]) {
      expect(
        withMethod({ kind: "query", input: idInput, output: "entity", describe: text }),
      ).toThrow('defineContract("taskService"): method "m": describe must be a non-empty string');
    }
  });

  it("rejects collection names that clash with a method or are reserved", () => {
    const list = query({ input: idInput, output: "entity" });
    expect(() =>
      define("taskService", { ...entityOnly, methods: { list }, collections: { list: byProject } }),
    ).toThrow('collection "list" has the same name as a method');
    expect(() =>
      define("taskService", { ...entityOnly, collections: { $all: byProject } }),
    ).toThrow('collection "$all" uses a reserved name');
    expect(() =>
      define("taskService", { ...entityOnly, collections: { then: byProject } }),
    ).toThrow('collection "then" uses a reserved name');
    // A change topic is {collection}:{scope}, split at its first colon.
    expect(() =>
      define("taskService", { ...entityOnly, collections: { "by:project": byProject } }),
    ).toThrow(
      'defineContract("taskService"): collection "by:project" may not contain ":"; a change topic is {collection}:{scope}, split at its first colon',
    );
  });

  it("requires an entity for projections, fields, collections and the entity projection", () => {
    expect(() => define("s", { projections: { card: taskCardSchema } })).toThrow(
      'projection "card" needs an entity',
    );
    expect(() => define("s", { fields: { title: "Admin" } })).toThrow(
      'field "title" needs an entity',
    );
    expect(() => define("s", { collections: { c: byProject } })).toThrow(
      'collection "c" needs an entity',
    );
    expect(() =>
      define("s", { methods: { get: query({ input: idInput, output: "entity" }) } }),
    ).toThrow('method "get" returns unknown projection "entity"; the projections are none');
  });

  it("rejects a projection named entity and invalid fields", () => {
    expect(() =>
      define("s", { entity: taskSchema, projections: { entity: taskCardSchema } }),
    ).toThrow('a projection is named "entity"');
    expect(() => define("s", { entity: taskSchema, fields: { id: "Admin" } })).toThrow(
      'fields cannot restrict "id"',
    );
    expect(() => define("s", { entity: taskSchema, fields: { title: "Owner" } })).toThrow(
      'field "title" must map to one of "Public", "Read", "Moderate", "Admin"',
    );
  });

  it("rejects unknown options", () => {
    expect(() => define("s", { entity: taskSchema, colections: {} })).toThrow(
      'the contract has an unknown option "colections"',
    );
    expect(withCollection({ limits: 5 })).toThrow('collection "c" has an unknown option "limits"');
    expect(() => define("s", { streams: { typing: { item: idInput, durable: true } } })).toThrow(
      'stream "typing" has an unknown option "durable"',
    );
    expect(() => define("s", { channels: { cursor: { payload: idInput, rate: 5 } } })).toThrow(
      'channel "cursor" has an unknown option "rate"',
    );
    expect(() => define("s", { events: { done: { payload: idInput, volatile: true } } })).toThrow(
      'event "done" has an unknown option "volatile"',
    );
  });

  it("rejects views without an index, and views that are not functions", () => {
    expect(withCollection({ views: { all: () => true } })).toThrow(
      'collection "c" declares views but no index',
    );
    expect(withCollection({ index: ["status"], views: { all: true } })).toThrow(
      'collection "c": views must map names to predicate functions',
    );
    expect(withCollection({ index: "status" })).toThrow('collection "c": index must be a list');
  });

  it("rejects limits that are not positive integers or exceed maxLimit", () => {
    for (const limit of [0, -1, 1.5, "10"]) {
      expect(withCollection({ limit })).toThrow("limit and maxLimit must be positive integers");
    }
    expect(withCollection({ limit: 600 })).toThrow("limit (600) is larger than maxLimit (500)");
    expect(withCollection({ maxLimit: 50 })).toThrow("limit (100) is larger than maxLimit (50)");
  });

  it("rejects an invalid scope, where filter or access level", () => {
    expect(withCollection({ scope: "" })).toThrow("scope must be a column name or via(");
    expect(withCollection({ scope: { kind: "via", model: "m", entry: "e" } })).toThrow(
      "scope must be a column name or via(",
    );
    expect(withCollection({ where: { archived: [false] } })).toThrow(
      "where must map columns to strings, numbers, booleans or null",
    );
    expect(withCollection({ access: "Owner" })).toThrow("access must be one of");
  });

  it("rejects values that are not Standard Schemas", () => {
    expect(() => define("s", { entity: { id: "string" } })).toThrow(
      "entity must be a Standard Schema",
    );
    expect(() => define("s", { entity: taskSchema, projections: { card: {} } })).toThrow(
      'projection "card" must be a Standard Schema',
    );
    expect(() => define("s", { channels: { cursor: { payload: "json" } } })).toThrow(
      'channel "cursor" must be { payload: <Standard Schema>, ... }',
    );
    expect(() => define("s", { events: { done: {} } })).toThrow(
      'event "done" must be { payload: <Standard Schema>, ... }',
    );
    expect(() => define("s", { streams: { logs: { item: null } } })).toThrow(
      'stream "logs" must be { item: <Standard Schema>, ... }',
    );
  });

  it("rejects a missing or empty service name, and a definition that is not an object", () => {
    expect(() => define("", {})).toThrow("the service name must be a non-empty string");
    expect(() => define(undefined, {})).toThrow("the service name must be a non-empty string");
    expect(() => define("s", null)).toThrow(
      'defineContract("s"): the definition must be an object',
    );
    expect(() => define("s", { methods: [] })).toThrow("methods must be an object");
  });
});

describe("streams, channels and events (RFC 0003 section 12.5)", () => {
  const cursor = z.object({ docId: z.string(), x: z.number(), y: z.number() });

  it("keeps every option, frozen", () => {
    const board = defineContract("boardService", {
      entity: taskSchema,
      methods: { get: query({ input: idInput, output: "entity" }) },
      collections: {
        byProject: { scope: "projectId", item: "entity", order: [["id", "asc"]] },
      },
      streams: {
        logs: {
          item: z.string(),
          scope: "taskId",
          seed: 50,
          volatile: true,
          access: { entry: "Read" },
        },
        metrics: { item: z.number(), access: "public" },
      },
      channels: {
        cursor: { payload: cursor, ratePerSecond: 20, burst: 5, requires: { entity: "docId" } },
        typing: {
          payload: z.object({ projectId: z.string() }),
          requires: { collection: "byProject", scope: (payload) => payload.projectId },
        },
      },
      events: { celebrated: { payload: z.object({ taskId: z.string() }) } },
    });
    expect(board.streams.logs).toMatchObject({ scope: "taskId", seed: 50, volatile: true });
    expect(board.channels.cursor).toMatchObject({
      ratePerSecond: 20,
      burst: 5,
      requires: { entity: "docId" },
    });
    expect(Object.isFrozen(board.streams.logs) && Object.isFrozen(board.channels.typing)).toBe(
      true,
    );
    expect(Object.keys(board.events)).toEqual(["celebrated"]);
  });

  it("shares one namespace with methods and collections, and reserves the same names", () => {
    const method = { get: query({ input: idInput, output: z.null() }) };
    expect(() => define("s", { methods: method, streams: { get: { item: idInput } } })).toThrow(
      'stream "get" has the same name as a method',
    );
    expect(() =>
      define("s", { streams: { x: { item: idInput } }, channels: { x: { payload: idInput } } }),
    ).toThrow('channel "x" has the same name as a stream');
    expect(() =>
      define("s", { channels: { x: { payload: idInput } }, events: { x: { payload: idInput } } }),
    ).toThrow('event "x" has the same name as a channel');
    expect(() =>
      define("s", {
        entity: taskSchema,
        collections: { c: { scope: "projectId", item: "entity", order: [["id", "asc"]] } },
        events: { c: { payload: idInput } },
      }),
    ).toThrow('event "c" has the same name as a collection');
    for (const name of ["then", "useEntity", "admin", "$x"]) {
      expect(() => define("s", { events: { [name]: { payload: idInput } } })).toThrow(
        `event "${name}" uses a reserved name`,
      );
    }
  });

  it("rejects stream options out of range, and row access on a global stream", () => {
    expect(() => define("s", { streams: { "a:b": { item: idInput } } })).toThrow(
      'may not contain ":"',
    );
    for (const seed of [-1, 1.5, 1001, "5"]) {
      expect(() => define("s", { streams: { logs: { item: idInput, seed } } })).toThrow(
        "seed must be a whole number from 0 to 1000",
      );
    }
    expect(() => define("s", { streams: { logs: { item: idInput, volatile: "yes" } } })).toThrow(
      "volatile must be a boolean",
    );
    expect(() => define("s", { streams: { logs: { item: idInput, scope: "" } } })).toThrow(
      'scope must be "global" or a non-empty name',
    );
    expect(() =>
      define("s", { streams: { logs: { item: idInput, access: { entry: "Read" } } } }),
    ).toThrow("entry and scope access check the scope's row, so the stream needs a scope");
    expect(() =>
      define("s", {
        streams: { logs: { item: idInput, scope: "global", access: { entry: "Read" } } },
      }),
    ).toThrow("so the stream needs a scope");
  });

  it("rejects stream access that is not one of the data forms", () => {
    const access = (value: unknown) => () =>
      define("s", { streams: { logs: { item: idInput, scope: "taskId", access: value } } });
    expect(access("anyone")).toThrow('access must be "public", "authenticated"');
    expect(access({ entry: "Owner" })).toThrow('access must be "public", "authenticated"');
    expect(access({ entry: "Read", id: "taskId" })).toThrow('has an unknown key "id"');
    expect(access({ scope: "Read" })).toThrow("a scope form is { scope, of: contract }");
    expect(access({ service: "Read", of: { name: "p" } })).toThrow("of belongs to scope forms");
    expect(access({ kind: "custom", check: () => true })).toThrow('access must be "public"');
    expect(() => access({ scope: "Read", of: { name: "projectService" } })()).not.toThrow();
  });

  it("rejects channel rates and requirements that cannot work", () => {
    const channel =
      (value: Record<string, unknown>, extra: Record<string, unknown> = {}) =>
      () =>
        define("s", { ...extra, channels: { cursor: { payload: cursor, ...value } } });
    expect(channel({ ratePerSecond: 0 })).toThrow(
      "ratePerSecond must be a number of messages above 0",
    );
    expect(channel({ burst: 0.5 })).toThrow("burst must be a number of messages, at least 1");
    expect(channel({ requires: { entity: "docId" } })).toThrow(
      "requires.entity needs the contract's entity",
    );
    expect(channel({ requires: { entity: "" } }, { entity: taskSchema })).toThrow(
      "requires.entity must be a payload key or a function of the payload",
    );
    expect(
      channel({ requires: { collection: "board", scope: "docId" } }, { entity: taskSchema }),
    ).toThrow('requires names unknown collection "board"');
    expect(channel({ requires: { collection: "board" } })).toThrow(
      "requires must be { entity } or { collection, scope }",
    );
    expect(channel({ requires: "docId" })).toThrow(
      "requires must be { entity } or { collection, scope }",
    );
  });
});
