// Type tests for contracts. `bun run typecheck` checks this file (tsconfig
// includes all of src/), and vitest's typecheck mode reports each assertion as
// a test. Everything is imported from the package root, the way an app does.

import { describe, expectTypeOf, test } from "vitest";
import { z } from "zod";
import { z as z3 } from "zod3";
import {
  defineContract,
  listOf,
  mutation,
  nullable,
  query,
  via,
  type AnyContract,
  type ChannelInputOf,
  type ChannelName,
  type ChannelPayloadOf,
  type CollectionName,
  type ContractMap,
  type EntityOf,
  type EventName,
  type EventPayloadOf,
  type IndexRowOf,
  type InferOutput,
  type InputOf,
  type IsScopedStream,
  type ItemOf,
  type KindOf,
  type MethodName,
  type OutputOf,
  type ParsedInputOf,
  type ProjectionName,
  type ProjectionOf,
  type RowSchema,
  type ScopeOf,
  type StandardSchemaV1,
  type StreamItemOf,
  type StreamName,
  type ViaScope,
  type ViewName,
} from "../index";

// ---------------------------------------------------------------------------
// The sample contract from RFC 0003 section 2, verbatim, with its schemas.
// ---------------------------------------------------------------------------

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
const renameSchema = z.object({ id: z.string(), title: z.string().min(1) });
const statsInput = z.object({ projectId: z.string(), days: z.number().int().default(30) });
const statsSchema = z.object({ open: z.number(), done: z.number() });

export const task = defineContract("taskService", {
  entity: taskSchema,
  projections: { card: taskCardSchema },
  fields: { internalNotes: "Admin" },
  methods: {
    get: query({ input: z.object({ id: z.string() }), output: "entity" }),
    rename: mutation({ input: renameSchema, output: "entity" }),
    stats: query({
      input: statsInput,
      output: statsSchema,
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

type Task = typeof task;

type TaskRow = {
  id: string;
  projectId: string;
  title: string;
  status: "todo" | "doing" | "done";
  ordinal: number;
  assigneeId: string | null;
  internalNotes: string;
  archived: boolean;
};

type CardRow = {
  id: string;
  title: string;
  status: "todo" | "doing" | "done";
  ordinal: number;
  assigneeId: string | null;
};

// ---------------------------------------------------------------------------
// Consumer-side derivations: what `defineService` (RFC 0003 section 3) and the
// client proxy (section 11) will build from a contract. If these are awkward
// to write, the contract types are wrong.
// ---------------------------------------------------------------------------

/** defineService: exactly one handler per contract method. */
type Handlers<C extends AnyContract> = {
  readonly [M in MethodName<C>]: (args: {
    readonly input: ParsedInputOf<C, M>;
  }) => Promise<OutputOf<C, M>>;
};

interface QueryMember<C extends AnyContract, M extends MethodName<C>> {
  readonly kind: "query";
  useQuery(input: InputOf<C, M>): { readonly data: OutputOf<C, M> | undefined };
  call(input: InputOf<C, M>): Promise<OutputOf<C, M>>;
}

interface MutationMember<C extends AnyContract, M extends MethodName<C>> {
  readonly kind: "mutation";
  useMutation(): { mutateAsync(input: InputOf<C, M>): Promise<OutputOf<C, M>> };
}

interface CollectionMember<C extends AnyContract, K extends CollectionName<C>> {
  useCollection(
    scope: ScopeOf<C, K>,
    options?: { readonly view?: ViewName<C, K> },
  ): { readonly items: readonly ItemOf<C, K>[]; readonly index: readonly IndexRowOf<C, K>[] };
}

/** The client proxy: `qd.task.get.useQuery(...)`, `qd.task.byProject.useCollection(...)`. */
type ServiceProxy<C extends AnyContract> = {
  readonly [M in MethodName<C>]: KindOf<C, M> extends "query"
    ? QueryMember<C, M>
    : MutationMember<C, M>;
} & { readonly [K in CollectionName<C>]: CollectionMember<C, K> } & {
  useEntity(id: string): EntityOf<C> | undefined;
};

type Client<Contracts extends ContractMap> = {
  readonly [Key in keyof Contracts]: ServiceProxy<Contracts[Key]>;
};

declare const qd: Client<{ task: Task }>;

describe("the RFC sample contract", () => {
  test("keeps the service name and is an AnyContract", () => {
    expectTypeOf(task.name).toEqualTypeOf<"taskService">();
    expectTypeOf(task).toExtend<AnyContract>();
    expectTypeOf<{ task: Task }>().toExtend<ContractMap>();
  });

  test("derives the entity and the projections", () => {
    expectTypeOf<EntityOf<Task>>().toEqualTypeOf<TaskRow>();
    expectTypeOf<ProjectionName<Task>>().toEqualTypeOf<"entity" | "card">();
    expectTypeOf<ProjectionOf<Task, "card">>().toEqualTypeOf<CardRow>();
    expectTypeOf<ProjectionOf<Task, "entity">>().toEqualTypeOf<TaskRow>();
    expectTypeOf(task.fields).toEqualTypeOf<{ readonly internalNotes: "Admin" }>();
  });

  test("derives method names, kinds, inputs and outputs", () => {
    expectTypeOf<MethodName<Task>>().toEqualTypeOf<"get" | "rename" | "stats">();
    expectTypeOf<KindOf<Task, "get">>().toEqualTypeOf<"query">();
    expectTypeOf<KindOf<Task, "rename">>().toEqualTypeOf<"mutation">();
    expectTypeOf<InputOf<Task, "rename">>().toEqualTypeOf<{ id: string; title: string }>();
    expectTypeOf<OutputOf<Task, "get">>().toEqualTypeOf<TaskRow>();
    expectTypeOf<OutputOf<Task, "rename">>().toEqualTypeOf<TaskRow>();
    expectTypeOf<OutputOf<Task, "stats">>().toEqualTypeOf<{ open: number; done: number }>();
  });

  test("separates what a caller passes from what a handler receives", () => {
    expectTypeOf<InputOf<Task, "stats">>().toEqualTypeOf<{ projectId: string; days?: number }>();
    expectTypeOf<ParsedInputOf<Task, "stats">>().toEqualTypeOf<{
      projectId: string;
      days: number;
    }>();
  });

  test("derives collection items, scopes, index rows and views", () => {
    expectTypeOf<CollectionName<Task>>().toEqualTypeOf<"byProject">();
    expectTypeOf<ItemOf<Task, "byProject">>().toEqualTypeOf<CardRow>();
    expectTypeOf<ScopeOf<Task, "byProject">>().toEqualTypeOf<string>();
    expectTypeOf<IndexRowOf<Task, "byProject">>().toEqualTypeOf<
      Pick<CardRow, "id" | "status" | "ordinal" | "assigneeId">
    >();
    expectTypeOf<ViewName<Task, "byProject">>().toEqualTypeOf<"mine">();
  });

  test("types a view's row as the index row", () => {
    type Mine = NonNullable<Task["collections"]["byProject"]["views"]>["mine"];
    expectTypeOf<Parameters<Mine>[0]>().toEqualTypeOf<IndexRowOf<Task, "byProject">>();
    expectTypeOf<Parameters<Mine>[1]>().toEqualTypeOf<{ readonly userId: string }>();
  });
});

describe("derivations for defineService and the client", () => {
  test("handlers implement exactly the contract's methods", () => {
    const row: TaskRow = {
      id: "t1",
      projectId: "p1",
      title: "Write the RFC",
      status: "todo",
      ordinal: 1,
      assigneeId: null,
      internalNotes: "",
      archived: false,
    };
    const handlers: Handlers<Task> = {
      get: ({ input }) => Promise.resolve({ ...row, id: input.id }),
      rename: ({ input }) => Promise.resolve({ ...row, title: input.title }),
      stats: ({ input }) => Promise.resolve({ open: input.days, done: 0 }),
    };
    expectTypeOf(handlers.stats).parameter(0).toEqualTypeOf<{
      readonly input: { projectId: string; days: number };
    }>();
    // @ts-expect-error -- a handler set without `stats` does not implement the contract
    const missing: Handlers<Task> = { get: handlers.get, rename: handlers.rename };
    expectTypeOf(missing).not.toBeAny();
  });

  test("the client proxy exposes hooks by kind", () => {
    expectTypeOf(qd.task.get.kind).toEqualTypeOf<"query">();
    expectTypeOf(qd.task.get.call).parameter(0).toEqualTypeOf<{ id: string }>();
    expectTypeOf(qd.task.get.call).returns.resolves.toEqualTypeOf<TaskRow>();
    expectTypeOf(qd.task.rename.kind).toEqualTypeOf<"mutation">();
    expectTypeOf(qd.task.rename.useMutation().mutateAsync)
      .parameter(0)
      .toEqualTypeOf<{ id: string; title: string }>();
    expectTypeOf(qd.task.stats.useQuery).toBeCallableWith({ projectId: "p1" });
    expectTypeOf(qd.task.useEntity).returns.toEqualTypeOf<TaskRow | undefined>();
  });

  test("collections take their scope type and view names", () => {
    expectTypeOf(qd.task.byProject.useCollection).toBeCallableWith("p1", { view: "mine" });
    expectTypeOf(qd.task.byProject.useCollection).returns.toEqualTypeOf<{
      readonly items: readonly CardRow[];
      readonly index: readonly IndexRowOf<Task, "byProject">[];
    }>();
    // @ts-expect-error -- "theirs" is not a view of byProject
    qd.task.byProject.useCollection("p1", { view: "theirs" });
  });
});

// ---------------------------------------------------------------------------
// Kits (RFC 0003 section 12) contribute method entries that an app spreads
// into `methods`. They refer to the contract's projections by name and may
// derive their schemas' types from the contract's entity.
// ---------------------------------------------------------------------------

/** A Standard Schema with a given type, the way a kit would generate one. */
function typedSchema<Output>(): StandardSchemaV1<Output> {
  return {
    "~standard": { version: 1, vendor: "kit", validate: (value) => ({ value: value as Output }) },
  };
}

const idInput = z.object({ id: z.string() });

/** A read/write kit: lookups by id plus a list of a lean projection. */
function readKit<const Item extends string>(item: Item) {
  return {
    get: query({ input: idInput, output: "entity" }),
    find: query({ input: idInput, output: nullable("entity") }),
    getMany: query({
      input: z.object({ ids: z.array(z.string()).max(200) }),
      output: listOf(item),
    }),
  };
}

/** An update kit whose input type is derived from the entity schema. */
function updateKit<Entity extends RowSchema>(_entity: Entity) {
  type Row = InferOutput<Entity>;
  return {
    update: mutation({
      input: typedSchema<Pick<Row, "id"> & Partial<Omit<Row, "id">>>(),
      output: "entity",
    }),
  };
}

export const board = defineContract("boardService", {
  entity: taskSchema,
  projections: { card: taskCardSchema },
  methods: {
    ...readKit("card"),
    ...updateKit(taskSchema),
    archive: mutation({ input: idInput, output: z.object({ archived: z.literal(true) }) }),
  },
  collections: {
    assigned: {
      scope: via({ model: "taskAssignee", entry: "taskId", scope: "userId" }),
      item: "entity",
      where: { archived: false },
      order: [["id", "desc"]],
      limit: 50,
    },
  },
  streams: { typing: { item: z.object({ userId: z.string() }) } },
  channels: { cursor: { payload: z.object({ x: z.number(), y: z.number() }) } },
  events: { celebrated: { payload: z.object({ taskId: z.string() }) } },
});

type Board = typeof board;

describe("methods composed from kits", () => {
  test("every spread entry keeps its types", () => {
    expectTypeOf<MethodName<Board>>().toEqualTypeOf<
      "get" | "find" | "getMany" | "update" | "archive"
    >();
    expectTypeOf<KindOf<Board, "update">>().toEqualTypeOf<"mutation">();
    expectTypeOf<OutputOf<Board, "get">>().toEqualTypeOf<TaskRow>();
    expectTypeOf<OutputOf<Board, "archive">>().toEqualTypeOf<{ archived: true }>();
  });

  test("nullable and listOf outputs resolve against the contract's projections", () => {
    expectTypeOf<OutputOf<Board, "find">>().toEqualTypeOf<TaskRow | null>();
    expectTypeOf<OutputOf<Board, "getMany">>().toEqualTypeOf<CardRow[]>();
    expectTypeOf<InputOf<Board, "getMany">>().toEqualTypeOf<{ ids: string[] }>();
  });

  test("a kit can derive its input type from the entity", () => {
    expectTypeOf<InputOf<Board, "update">>().toEqualTypeOf<
      Pick<TaskRow, "id"> & Partial<Omit<TaskRow, "id">>
    >();
    expectTypeOf<InputOf<Board, "update">>().toExtend<{ id: string; title?: string }>();
  });

  test("a via scope is a string; streams, channels and events keep their payloads", () => {
    expectTypeOf<ScopeOf<Board, "assigned">>().toEqualTypeOf<string>();
    expectTypeOf<ItemOf<Board, "assigned">>().toEqualTypeOf<TaskRow>();
    expectTypeOf<ViewName<Board, "assigned">>().toEqualTypeOf<never>();
    expectTypeOf(board.collections.assigned.scope).toEqualTypeOf<
      ViaScope<"taskAssignee", "taskId", "userId">
    >();
    expectTypeOf<StreamItemOf<Board, "typing">>().toEqualTypeOf<{ userId: string }>();
    expectTypeOf<ChannelPayloadOf<Board, "cursor">>().toEqualTypeOf<{ x: number; y: number }>();
    expectTypeOf<EventPayloadOf<Board, "celebrated">>().toEqualTypeOf<{ taskId: string }>();
  });
});

// ---------------------------------------------------------------------------
// Any Standard Schema: Zod 3.25, Zod 4 and a hand-written one.
// ---------------------------------------------------------------------------

const chatSchema3 = z3.object({
  id: z3.string(),
  ownerId: z3.string(),
  title: z3.string(),
  pinned: z3.boolean(),
});

export const chat3 = defineContract("chatService", {
  entity: chatSchema3,
  projections: { lean: chatSchema3.pick({ id: true, title: true, pinned: true }) },
  fields: { pinned: "Moderate" },
  methods: {
    rename: mutation({ input: z3.object({ id: z3.string(), title: z3.string() }), output: "lean" }),
    count: query({ input: z3.object({ ownerId: z3.string() }), output: z3.number() }),
    mixed: query({ input: z.object({ id: z.string() }), output: nullable("lean") }),
  },
  collections: {
    mine: {
      scope: "ownerId",
      item: "lean",
      order: [["id", "asc"]],
      index: ["pinned"],
      views: { pinned: (row) => row.pinned },
    },
    all: {
      scope: "ownerId",
      item: "entity",
      order: [
        ["title", "asc"],
        ["id", "asc"],
      ],
      index: ["title"],
      views: { titled: (row) => row.title.length > 0 },
    },
  },
});

type Chat3 = typeof chat3;
type Chat3Row = { id: string; ownerId: string; title: string; pinned: boolean };

describe("schemas from any Standard Schema library", () => {
  test("accepts Zod 3.25 schemas everywhere, mixed with Zod 4", () => {
    expectTypeOf(chat3).toExtend<AnyContract>();
    expectTypeOf<{ task: Task; chat: Chat3 }>().toExtend<ContractMap>();
    expectTypeOf<EntityOf<Chat3>>().toEqualTypeOf<Chat3Row>();
    expectTypeOf<OutputOf<Chat3, "rename">>().toEqualTypeOf<{
      id: string;
      title: string;
      pinned: boolean;
    }>();
    expectTypeOf<OutputOf<Chat3, "count">>().toEqualTypeOf<number>();
    expectTypeOf<InputOf<Chat3, "mixed">>().toEqualTypeOf<{ id: string }>();
    expectTypeOf<IndexRowOf<Chat3, "mine">>().toEqualTypeOf<{ id: string; pinned: boolean }>();
    expectTypeOf<IndexRowOf<Chat3, "all">>().toEqualTypeOf<{ id: string; title: string }>();
  });

  test("accepts a hand-written Standard Schema", () => {
    const noteSchema = typedSchema<{ id: string; body: string }>();
    const notes = defineContract("noteService", {
      entity: noteSchema,
      methods: { get: query({ input: typedSchema<{ id: string }>(), output: "entity" }) },
    });
    expectTypeOf<OutputOf<typeof notes, "get">>().toEqualTypeOf<{ id: string; body: string }>();
  });

  test("a contract without an entity is an RPC service", () => {
    const search = defineContract("searchService", {
      methods: {
        search: query({ input: z.object({ q: z.string() }), output: z.array(z.string()) }),
      },
    });
    expectTypeOf<OutputOf<typeof search, "search">>().toEqualTypeOf<string[]>();
    expectTypeOf<EntityOf<typeof search>>().toBeNever();
    expectTypeOf<ProjectionName<typeof search>>().toBeNever();
    expectTypeOf(search.entity).toBeUndefined();
    expectTypeOf<CollectionName<typeof search>>().toBeNever();
  });
});

// ---------------------------------------------------------------------------
// Rules that fail to compile. Each `@ts-expect-error` sits on the line the
// compiler reports, so a rule that stops failing breaks `bun run typecheck`.
// The runtime checks for the same rules are in defineContract.test.ts.
// ---------------------------------------------------------------------------

const cardOnly = { card: taskCardSchema };

describe("methods that fail to compile", () => {
  test("reserved method names", () => {
    defineContract("reserved", {
      entity: taskSchema,
      methods: {
        // @ts-expect-error -- subscribe is reserved by the protocol
        subscribe: query({ input: idInput, output: "entity" }),
        // @ts-expect-error -- names starting with $ are reserved
        $internal: query({ input: idInput, output: "entity" }),
        // @ts-expect-error -- then would make the service's caller look like a promise
        then: query({ input: idInput, output: "entity" }),
      },
    });
  });

  test("outputs that name an unknown projection", () => {
    defineContract("outputs", {
      entity: taskSchema,
      projections: cardOnly,
      methods: {
        // @ts-expect-error -- "summary" is not a projection
        a: query({ input: idInput, output: "summary" }),
        // @ts-expect-error -- listOf needs a known projection too
        b: query({ input: idInput, output: listOf("summary") }),
        // @ts-expect-error -- and so does nullable
        c: query({ input: idInput, output: nullable("summary") }),
      },
    });
    defineContract("noEntity", {
      // @ts-expect-error -- a contract without an entity has no "entity" projection
      methods: { a: query({ input: idInput, output: "entity" }) },
    });
  });

  test("watching an unknown collection, or watching from a mutation", () => {
    defineContract("watch", {
      entity: taskSchema,
      methods: {
        // @ts-expect-error -- there is no collection named "byOwner"
        a: query({
          input: idInput,
          output: "entity",
          watch: { collection: "byOwner", scope: (i) => i.id },
        }),
      },
      collections: { byProject: { scope: "projectId", item: "entity", order: [["id", "asc"]] } },
    });
    mutation({
      input: idInput,
      output: "entity",
      // @ts-expect-error -- only a query can watch
      watch: { collection: "byProject", scope: () => "p1" },
    });
  });

  test("an input that is not a Standard Schema", () => {
    // @ts-expect-error -- a plain object is not a schema
    query({ input: { id: "string" }, output: "entity" });
  });

  test("a describe text that is not a string", () => {
    const described = query({ input: idInput, output: "entity", describe: "Reads one task." });
    expectTypeOf(described.describe).toEqualTypeOf<string | undefined>();
    expectTypeOf(mutation({ input: idInput, output: "entity" }).describe).toEqualTypeOf<
      string | undefined
    >();
    const contract = defineContract("described", {
      entity: taskSchema,
      methods: {
        get: described,
        rename: mutation({ input: renameSchema, output: "entity", describe: "Renames a task." }),
      },
    });
    expectTypeOf(contract.methods.get.describe).toEqualTypeOf<string | undefined>();
    query({
      input: idInput,
      output: "entity",
      // @ts-expect-error -- describe is text for people and agents
      describe: 42,
    });
    mutation({
      input: idInput,
      output: "entity",
      // @ts-expect-error -- and so is a mutation's
      describe: ["Renames"],
    });
  });
});

describe("collections that fail to compile", () => {
  test("a view that reads a field outside the index", () => {
    defineContract("views", {
      entity: taskSchema,
      projections: cardOnly,
      collections: {
        byProject: {
          scope: "projectId",
          item: "card",
          order: [["id", "asc"]],
          index: ["status"],
          views: {
            open: (row) => row.status !== "done",
            // @ts-expect-error -- title is a card field but not an index field
            titled: (row) => row.title.length > 0,
          },
        },
      },
    });
  });

  test("views without an index", () => {
    defineContract("noIndex", {
      entity: taskSchema,
      collections: {
        byProject: {
          scope: "projectId",
          item: "entity",
          order: [["id", "asc"]],
          // @ts-expect-error -- views read index rows, so they need an index
          views: { all: () => true },
        },
      },
    });
  });

  test("an item that is not a projection, and index fields outside the item", () => {
    defineContract("items", {
      entity: taskSchema,
      projections: cardOnly,
      collections: {
        // @ts-expect-error -- "summary" is not a projection
        a: { scope: "projectId", item: "summary", order: [["id", "asc"]] },
        b: {
          scope: "projectId",
          item: "card",
          order: [["id", "asc"]],
          // @ts-expect-error -- projectId is an entity field, not a card field
          index: ["status", "projectId"],
        },
      },
    });
  });

  test("a scope that is not a string column, and an order that does not end in id", () => {
    defineContract("columns", {
      entity: taskSchema,
      collections: {
        a: {
          // @ts-expect-error -- ordinal is a number column
          scope: "ordinal",
          item: "entity",
          order: [["id", "asc"]],
        },
        b: {
          scope: "projectId",
          item: "entity",
          // @ts-expect-error -- the last sort column must be id
          order: [["ordinal", "asc"]],
        },
        c: {
          scope: "projectId",
          item: "entity",
          order: [
            // @ts-expect-error -- rank is not a column
            ["rank", "asc"],
            ["id", "asc"],
          ],
        },
      },
    });
  });

  test("a where filter on an unknown column or with the wrong value type", () => {
    defineContract("where", {
      entity: taskSchema,
      collections: {
        a: {
          scope: "projectId",
          item: "entity",
          order: [["id", "asc"]],
          // @ts-expect-error -- deleted is not a field of the entity
          where: { deleted: false },
        },
        b: {
          scope: "projectId",
          item: "entity",
          order: [["id", "asc"]],
          // @ts-expect-error -- archived is a boolean
          where: { archived: "no" },
        },
      },
    });
  });

  test("collection names that clash, unknown options, and no entity", () => {
    defineContract("names", {
      entity: taskSchema,
      methods: { list: query({ input: idInput, output: "entity" }) },
      collections: {
        // @ts-expect-error -- the client would expose both as qd.names.list
        list: { scope: "projectId", item: "entity", order: [["id", "asc"]] },
        // @ts-expect-error -- call is reserved
        call: { scope: "projectId", item: "entity", order: [["id", "asc"]] },
        // @ts-expect-error -- limits is a typo for limit
        typo: { scope: "projectId", item: "entity", order: [["id", "asc"]], limits: 5 },
      },
    });
    defineContract("noEntity", {
      collections: {
        // @ts-expect-error -- collections are rows of the entity
        a: { scope: "projectId", item: "entity", order: [["id", "asc"]] },
      },
    });
  });
});

describe("contracts that fail to compile", () => {
  test("an entity without an id", () => {
    defineContract("noId", {
      // @ts-expect-error -- the entity must have id: string
      entity: z.object({ title: z.string() }),
    });
  });

  test("projections named entity, or without an entity", () => {
    defineContract("implicit", {
      entity: taskSchema,
      // @ts-expect-error -- "entity" is the implicit full-row projection
      projections: { entity: taskCardSchema },
    });
    defineContract("noEntity", {
      // @ts-expect-error -- projections are lean shapes of the entity
      projections: { card: taskCardSchema },
    });
  });

  test("fields that are unknown, id, or not a level", () => {
    defineContract("fields", {
      entity: taskSchema,
      // @ts-expect-error -- secret is not a field of the entity
      fields: { secret: "Admin" },
    });
    defineContract("idField", {
      entity: taskSchema,
      // @ts-expect-error -- every subscriber receives id
      fields: { id: "Admin" },
    });
    defineContract("level", {
      entity: taskSchema,
      // @ts-expect-error -- Owner is not an access level
      fields: { title: "Owner" },
    });
  });

  test("an unknown contract option", () => {
    defineContract("typo", {
      entity: taskSchema,
      // @ts-expect-error -- colections is a typo for collections
      colections: {},
    });
  });
});

// ---------------------------------------------------------------------------
// Streams, channels and events (RFC 0003 section 12.5).
// ---------------------------------------------------------------------------

const cursorSchema = z.object({ docId: z.string(), x: z.number().default(0), y: z.number() });

const realtime = defineContract("realtimeService", {
  entity: taskSchema,
  collections: { byProject: { scope: "projectId", item: "entity", order: [["id", "asc"]] } },
  streams: {
    logs: { item: z.object({ line: z.string() }), scope: "taskId", seed: 20 },
    metrics: { item: z.number(), access: "public" },
    named: { item: z.number(), scope: "global" },
  },
  channels: {
    cursor: { payload: cursorSchema, requires: { entity: "docId" } },
    typing: {
      payload: z.object({ projectId: z.string(), on: z.boolean() }),
      requires: { collection: "byProject", scope: (payload) => payload.projectId },
    },
  },
  events: { celebrated: { payload: z.object({ taskId: z.string() }) } },
});

type Realtime = typeof realtime;

describe("streams, channels and events", () => {
  test("names and payload types come from the contract", () => {
    expectTypeOf<StreamName<Realtime>>().toEqualTypeOf<"logs" | "metrics" | "named">();
    expectTypeOf<ChannelName<Realtime>>().toEqualTypeOf<"cursor" | "typing">();
    expectTypeOf<EventName<Realtime>>().toEqualTypeOf<"celebrated">();
    expectTypeOf<StreamItemOf<Realtime, "logs">>().toEqualTypeOf<{ line: string }>();
    expectTypeOf<ChannelPayloadOf<Realtime, "cursor">>().toEqualTypeOf<{
      docId: string;
      x: number;
      y: number;
    }>();
    expectTypeOf<ChannelInputOf<Realtime, "cursor">>().toEqualTypeOf<{
      docId: string;
      x?: number | undefined;
      y: number;
    }>();
  });

  test("a stream is scoped when it names a scope other than global", () => {
    expectTypeOf<IsScopedStream<Realtime, "logs">>().toEqualTypeOf<true>();
    expectTypeOf<IsScopedStream<Realtime, "metrics">>().toEqualTypeOf<false>();
    expectTypeOf<IsScopedStream<Realtime, "named">>().toEqualTypeOf<false>();
  });

  test("a requires function receives the parsed payload, and the contract stays a contract", () => {
    const anyContract: AnyContract = realtime;
    expectTypeOf(anyContract.channels).toExtend<Readonly<Record<string, unknown>>>();
    defineContract("selectors", {
      entity: taskSchema,
      channels: {
        cursor: {
          payload: cursorSchema,
          requires: {
            entity: (payload) => {
              expectTypeOf(payload).toEqualTypeOf<{ docId: string; x: number; y: number }>();
              return payload.docId;
            },
          },
        },
      },
    });
  });

  test("a requirement must name a string key of the payload, a collection and an entity", () => {
    defineContract("badKey", {
      entity: taskSchema,
      channels: {
        // @ts-expect-error -- "x" holds a number, not a row id
        cursor: { payload: cursorSchema, requires: { entity: "x" } },
      },
    });
    defineContract("badCollection", {
      entity: taskSchema,
      channels: {
        // @ts-expect-error -- there is no collection named "board"
        typing: { payload: cursorSchema, requires: { collection: "board", scope: "docId" } },
      },
    });
    defineContract("noEntity", {
      channels: {
        // @ts-expect-error -- requires.entity needs an entity
        cursor: { payload: cursorSchema, requires: { entity: "docId" } },
      },
    });
  });

  test("a room requirement names an app room, or reads one from the parsed payload", () => {
    defineContract("rooms", {
      channels: {
        move: { payload: cursorSchema, requires: { room: "world" } },
        lobby: {
          payload: z.object({ lobbyId: z.string(), x: z.number() }),
          requires: {
            room: (payload) => {
              expectTypeOf(payload).toEqualTypeOf<{ lobbyId: string; x: number }>();
              return `lobby:${payload.lobbyId}`;
            },
          },
        },
        fixed: { payload: cursorSchema, requires: { room: () => "docId" } },
      },
    });
  });

  test("a requires function leaves a collection's plain options known", () => {
    // Before the room card, a function here made `access` an unknown collection option.
    defineContract("functionAndOptions", {
      entity: taskSchema,
      collections: {
        byProject: {
          scope: "projectId",
          item: "entity",
          order: [["id", "asc"]],
          access: "Moderate",
          limit: 20,
          maxLimit: 50,
        },
      },
      channels: {
        cursor: { payload: cursorSchema, requires: { room: (payload) => `doc:${payload.docId}` } },
        typing: { payload: cursorSchema, requires: { entity: (payload) => payload.docId } },
      },
    });
  });

  test("a room requirement is never reserved, never a payload key, never mixed with another form", () => {
    defineContract("reservedRoom", {
      channels: {
        // @ts-expect-error -- qd: rooms are the framework's own
        move: { payload: cursorSchema, requires: { room: "qd:e:taskService:t1@Read" } },
      },
    });
    defineContract("userRoom", {
      channels: {
        // @ts-expect-error -- user: rooms are the framework's own
        move: { payload: cursorSchema, requires: { room: "user:ada" } },
      },
    });
    defineContract("keyRoom", {
      channels: {
        // @ts-expect-error -- a room named "docId": the payload's docId needs (payload) => payload.docId
        move: { payload: cursorSchema, requires: { room: "docId" } },
      },
    });
    defineContract("mixedRoom", {
      entity: taskSchema,
      channels: {
        // @ts-expect-error -- one form at a time
        move: { payload: cursorSchema, requires: { entity: "docId", room: "world" } },
      },
    });
  });

  test("streams, channels and events share the namespace of methods and collections", () => {
    defineContract("clash", {
      methods: { get: query({ input: idInput, output: z.null() }) },
      streams: {
        // @ts-expect-error -- a method is named get
        get: { item: z.number() },
      },
      channels: {
        // @ts-expect-error -- then is reserved
        then: { payload: z.number() },
      },
      events: {
        // @ts-expect-error -- a method is named get
        get: { payload: z.number() },
      },
    });
    defineContract("clashLive", {
      streams: { x: { item: z.number() } },
      channels: {
        // @ts-expect-error -- a stream is named x
        x: { payload: z.number() },
      },
    });
  });
});
