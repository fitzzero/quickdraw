// Type tests for the admin kit (RFC 0003 section 12.4). `bun run typecheck`
// checks this file, and vitest's typecheck mode reports each block as a
// test. Each `@ts-expect-error` sits on the line the compiler reports, so a
// rule that stops failing breaks the typecheck.

import { describe, expectTypeOf, test } from "vitest";
import { z } from "zod";
import {
  adminOf,
  createQuickdrawClient,
  useAdminServices,
  type AdminKeysOf,
  type AdminRow,
  type AdminScreen,
} from "../../../client/index";
import {
  admin as adminContract,
  defineContract,
  query,
  type AdminFieldConfig,
  type AdminPage,
  type AdminServiceMeta,
  type AdminSubscribers,
  type InputOf,
  type OutputOf,
  type ParsedInputOf,
} from "../../../index";
import { createMockClient } from "../../../testing/client";
import { admin, custom, inherit, initQuickdraw, type Principal } from "../../index";

const taskRow = z.object({
  id: z.string(),
  projectId: z.string(),
  title: z.string(),
  status: z.enum(["open", "done"]),
  ordinal: z.number(),
  details: z.json(),
  createdAt: z.iso.datetime(),
  updatedAt: z.iso.datetime(),
});

type TaskRow = z.output<typeof taskRow>;

const project = defineContract("projectService", {
  entity: z.object({ id: z.string(), name: z.string() }),
});

const task = defineContract("taskService", {
  entity: taskRow,
  methods: {
    ...adminContract.contract({ entity: taskRow, filter: ["status"], sort: ["createdAt"] }),
    get: query({ input: z.object({ id: z.string() }), output: "entity" }),
  },
});

const plain = defineContract("plainService", {
  entity: taskRow,
  methods: { get: query({ input: z.object({ id: z.string() }), output: "entity" }) },
});

interface Db {
  readonly task: { findUnique(args: object): Promise<TaskRow> };
}

const qd = initQuickdraw<{ db: Db; principal: Principal }>();

describe("admin.contract", () => {
  test("types each method's input and output from the entity", () => {
    expectTypeOf<OutputOf<typeof task, "adminList">>().toEqualTypeOf<AdminPage<TaskRow>>();
    expectTypeOf<OutputOf<typeof task, "adminGet">>().toEqualTypeOf<TaskRow>();
    expectTypeOf<OutputOf<typeof task, "adminUpdate">>().toEqualTypeOf<TaskRow>();
    expectTypeOf<OutputOf<typeof task, "adminDelete">>().toEqualTypeOf<null>();
    expectTypeOf<OutputOf<typeof task, "adminMeta">>().toEqualTypeOf<AdminServiceMeta>();
    expectTypeOf<OutputOf<typeof task, "adminReemit">>().toEqualTypeOf<AdminSubscribers>();
    expectTypeOf<InputOf<typeof task, "adminList">>().toMatchTypeOf<
      | {
          readonly page?: number;
          readonly pageSize?: number;
          readonly filter?: { readonly status?: "open" | "done" };
          readonly sort?: { readonly field: "createdAt"; readonly direction?: "asc" | "desc" };
        }
      | undefined
    >();
    expectTypeOf<ParsedInputOf<typeof task, "adminList">["pageSize"]>().toEqualTypeOf<number>();
    expectTypeOf<keyof InputOf<typeof task, "adminUpdate">["data"]>().toEqualTypeOf<
      "projectId" | "title" | "status" | "ordinal" | "details"
    >();
  });

  test("restricts filter and sort to the entity's scalar fields, and expose to the kit's methods", () => {
    adminContract.contract({
      entity: taskRow,
      // @ts-expect-error details holds JSON
      filter: ["details"],
    });
    adminContract.contract({
      entity: taskRow,
      // @ts-expect-error nope is not a field of the entity
      sort: ["nope"],
    });
    // @ts-expect-error adminPurge is not an admin method
    adminContract.contract({ entity: taskRow, expose: ["adminPurge"] });
    expectTypeOf<
      keyof ReturnType<
        typeof adminContract.contract<{ entity: typeof taskRow; expose: ["adminGet"] }>
      >
    >().toEqualTypeOf<"adminGet">();
  });

  test("the writes never take id or the timestamps", () => {
    const update = (input: InputOf<typeof task, "adminUpdate">) => input;
    update({ id: "t1", data: { title: "New", status: "done" } });
    // @ts-expect-error id is not writable
    update({ id: "t1", data: { id: "t2" } });
    // @ts-expect-error createdAt is not writable
    update({ id: "t1", data: { createdAt: "2026-01-01T00:00:00.000Z" } });
  });
});

describe("AdminFieldConfig", () => {
  test("takes a 4.x field configuration, which has no filterable", () => {
    // A 4.x story or config literal: every 4.1 field but no `filterable`, which 5.0 added.
    const legacy = {
      name: "title",
      type: "string",
      label: "Title",
      required: true,
      editable: true,
      showInTable: true,
      sortable: true,
    } as const;
    expectTypeOf(legacy).toExtend<AdminFieldConfig>();
    expectTypeOf<AdminFieldConfig["filterable"]>().toEqualTypeOf<boolean | undefined>();
  });
});

describe("admin.handlers", () => {
  test("runs every method under a service-wide Admin grant, inside defineService", () => {
    const made = admin.handlers(task);
    expectTypeOf(made.adminList.access).toEqualTypeOf<{ readonly service: "Admin" }>();
    expectTypeOf(made.adminReemit.access).toEqualTypeOf<{ readonly service: "Admin" }>();
    expectTypeOf<keyof typeof made>().toEqualTypeOf<
      | "adminList"
      | "adminGet"
      | "adminCreate"
      | "adminUpdate"
      | "adminDelete"
      | "adminMeta"
      | "adminSubscribers"
      | "adminReemit"
    >();
    const service = qd.defineService(task, {
      model: "task",
      access: inherit({ from: project, via: "projectId" }),
      methods: {
        ...made,
        get: {
          access: { entry: "Read" },
          handler: ({ input, db }) => db.task.findUnique({ where: { id: input.id } }),
        },
      },
    });
    expectTypeOf(service.contract).toEqualTypeOf<typeof task>();
    // A service without a policy may use the kit too: { service } needs no row access.
    const unguarded = defineContract("unguardedService", {
      entity: taskRow,
      methods: { ...adminContract.contract({ entity: taskRow, expose: ["adminGet"] }) },
    });
    qd.defineService(unguarded, { model: "task", methods: { ...admin.handlers(unguarded) } });
  });

  test("access replaces a method's form, typed by that method's input", () => {
    const made = admin.handlers(task, {
      access: {
        adminGet: { entry: "Admin" },
        adminUpdate: custom((ctx, input) => {
          expectTypeOf(ctx.principal).toEqualTypeOf<Principal>();
          expectTypeOf(input.data).toEqualTypeOf<Readonly<Record<string, unknown>>>();
          return input.id.length > 0;
        }),
      },
      displayName: "Tasks",
      hiddenFields: ["details"],
      fieldOverrides: { title: { label: "Name" } },
    });
    expectTypeOf(made.adminGet.access).toEqualTypeOf<{ readonly entry: "Admin" }>();
    expectTypeOf(made.adminList.access).toEqualTypeOf<{ readonly service: "Admin" }>();
    admin.handlers(task, {
      // @ts-expect-error adminList's input has no id: an entry form must name one
      access: { adminList: { entry: "Admin" } },
    });
    admin.handlers(task, {
      // @ts-expect-error get is not a method admin.contract made
      access: { get: "public" },
    });
    // @ts-expect-error nope is not a field of the entity
    admin.handlers(task, { hiddenFields: ["nope"] });
    // @ts-expect-error id cannot be hidden
    admin.handlers(task, { hiddenFields: ["id"] });
    // @ts-expect-error sortable follows the contract's declared fields
    admin.handlers(task, { fieldOverrides: { title: { sortable: true } } });
  });

  test("a contract without the kit's methods does not compile", () => {
    // @ts-expect-error plainService has no method admin.contract made
    admin.handlers(plain);
  });

  test("grants is for an entity that holds serviceAccess", () => {
    const userRow = z.object({
      id: z.string(),
      name: z.string(),
      serviceAccess: z.record(z.string(), z.string()).nullable(),
    });
    const users = defineContract("userService", {
      entity: userRow,
      methods: { ...adminContract.contract({ entity: userRow }) },
    });
    admin.handlers(users, { grants: true });
    // @ts-expect-error the task entity holds no grants
    admin.handlers(task, { grants: true });
  });
});

describe("the client", () => {
  const client = createQuickdrawClient({ taskService: task, plain });

  test("gathers the admin methods' members under qd.<service>.admin, typed", () => {
    expectTypeOf(client.taskService.admin.adminList.useQuery).toBeFunction();
    expectTypeOf(client.taskService.admin.adminList.useQuery({ page: 2 }).data).toEqualTypeOf<
      AdminPage<TaskRow> | undefined
    >();
    expectTypeOf(client.taskService.admin.adminMeta.useQuery().data).toEqualTypeOf<
      AdminServiceMeta | undefined
    >();
    expectTypeOf(client.taskService.admin.adminUpdate.useMutation).toBeFunction();
    // The members are the service's own, under their names in the contract.
    expectTypeOf(client.taskService.adminGet.call).toBeFunction();
    // @ts-expect-error get is not an admin method
    expectTypeOf(client.taskService.admin.get).toBeObject();
  });

  test("a service without the kit has no admin member", () => {
    // @ts-expect-error plainService's contract has no admin method
    expectTypeOf(client.plain.admin).toBeObject();
  });

  test("useAdminServices lists the keys of the services with the kit", () => {
    const { services, isLoading } = useAdminServices(client);
    expectTypeOf(services[0]?.key).toEqualTypeOf<"taskService" | undefined>();
    expectTypeOf(services[0]?.displayName).toEqualTypeOf<string | undefined>();
    expectTypeOf(isLoading).toBeBoolean();
  });

  test("useAdminServices takes the grant a service's adminMeta needs, or null for none", () => {
    void useAdminServices(client, { requires: "Moderate" });
    void useAdminServices(client, { requires: null });
    // @ts-expect-error a requirement is an access level
    void useAdminServices(client, { requires: "Owner" });
  });

  test("adminOf gives every service's admin members one shape, by field name", () => {
    const other = defineContract("noteService", {
      entity: z.object({ id: z.string(), body: z.string() }),
      methods: {
        ...adminContract.contract({
          entity: z.object({ id: z.string(), body: z.string() }),
          sort: ["body"],
          expose: ["adminList", "adminMeta"],
        }),
      },
    });
    const both = createQuickdrawClient({ taskService: task, notes: other, plain });
    const pick = (key: AdminKeysOf<typeof both>) => adminOf(both, key);
    expectTypeOf(pick).returns.toEqualTypeOf<AdminScreen>();
    const screen = pick("notes");
    // A field named at run time, from adminMeta, for either service.
    const field: string = "body";
    expectTypeOf(screen.adminList.useQuery({ page: 1, sort: { field } }).data).toEqualTypeOf<
      AdminPage<AdminRow> | undefined
    >();
    expectTypeOf(screen.adminMeta.useQuery(undefined).data).toEqualTypeOf<
      AdminServiceMeta | undefined
    >();
    // A method the contract may not expose is optional.
    expectTypeOf(screen.adminUpdate).toEqualTypeOf<AdminScreen["adminUpdate"]>();
    screen.adminUpdate?.useMutation().mutate({ id: "n1", data: { body: "x" } });
    // @ts-expect-error a key without the admin kit
    adminOf(both, "plain");
  });

  test("a mock client has the same admin member, with stubs", () => {
    const mock = createMockClient({ taskService: task, plain });
    mock.taskService.admin.adminMeta.mockResolvedValue({
      serviceName: "taskService",
      displayName: "Tasks",
      fields: [],
    });
    expectTypeOf(mock.taskService.admin.adminList.calls).toEqualTypeOf<
      readonly InputOf<typeof task, "adminList">[]
    >();
    // @ts-expect-error plainService's contract has no admin method
    expectTypeOf(mock.plain.admin).toBeObject();
    expectTypeOf(useAdminServices(mock).services[0]?.key).toEqualTypeOf<
      "taskService" | undefined
    >();
  });
});
