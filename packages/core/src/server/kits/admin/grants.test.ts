// The admin kit and users' service-wide grants (finding F2.3 of the
// quickdraw-chat migration): `serviceAccess` stays hidden and unwritten by
// default; `admin.handlers(contract, { grants: true })` shows and writes it,
// for callers whose own service-wide grant is `Admin` only, whatever form a
// method runs under; the write is a tracked write of the grants column, so
// with `auth.serviceAccessSource` the user's open sockets get their new
// grants at once.

import { createServer as createHttpServer } from "node:http";
import type { AddressInfo } from "node:net";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import { admin as adminContract, defineContract } from "../../../index";
import { createTestApp, emitWithAck, type TestApp } from "../../../testing/index";
import { captureLogger } from "../../__tests__/fixtures";
import { qd } from "../../emit/__tests__/live";
import {
  admin,
  createDispatcher,
  createHttpRouter,
  owner,
  type AnyService,
  type HttpRouter,
} from "../../index";
import { adminApp, as } from "./__tests__/fixture";

const level = z.enum(["Public", "Read", "Moderate", "Admin"]);

const userEntity = z.object({
  id: z.string(),
  email: z.string(),
  name: z.string(),
  serviceAccess: z.record(z.string(), level).nullable(),
});

const userContract = defineContract("userService", {
  entity: userEntity,
  methods: { ...adminContract.contract({ entity: userEntity, sort: ["name"] }) },
});

const plainUsers = qd.defineService(userContract, {
  model: "user",
  access: owner("id"),
  methods: { ...admin.handlers(userContract) },
});

const grantingUsers = qd.defineService(userContract, {
  model: "user",
  access: owner("id"),
  methods: {
    ...admin.handlers(userContract, {
      grants: true,
      // A lowered form for the reads and writes: grants still need a service-wide Admin.
      access: { adminGet: { service: "Moderate" }, adminUpdate: { service: "Moderate" } },
      rowless: ["adminGet", "adminUpdate"],
    }),
  },
});

const kit = adminApp();

async function start(service: typeof plainUsers): Promise<TestApp> {
  const { db, prisma } = kit.harness();
  const app = await createTestApp({
    services: [service],
    db,
    auth: {
      loadServiceAccess: async (userId) => {
        const row = await prisma.user.findUnique({
          where: { id: userId },
          select: { serviceAccess: true },
        });
        return (row?.serviceAccess ?? {}) as Record<string, z.infer<typeof level>>;
      },
      // A tracked write to User.serviceAccess refreshes that user's open sockets.
      serviceAccessSource: { model: "user", column: "serviceAccess" },
    },
  });
  kit.track(app as unknown as TestApp);
  return app as unknown as TestApp;
}

/** A user administrator: a service-wide `Admin` grant on the users service. */
const usersAdmin = (userId: string) => as(userId, { userService: "Admin" });

type Users = {
  readonly userService: {
    adminMeta(input: undefined): Promise<{ readonly fields: readonly { readonly name: string }[] }>;
    adminGet(input: { readonly id: string }): Promise<Record<string, unknown>>;
    adminUpdate(input: {
      readonly id: string;
      readonly data: Readonly<Record<string, unknown>>;
    }): Promise<Record<string, unknown>>;
  };
};

const callerOf = (app: TestApp, principal: ReturnType<typeof as>): Users =>
  app.as(principal) as unknown as Users;

describe("serviceAccess in the admin kit", () => {
  it("stays hidden and unwritten by default", async () => {
    const app = await start(plainUsers);
    const board = kit.board();
    const users = callerOf(app, usersAdmin(board.ada));
    const meta = await users.userService.adminMeta(undefined);
    expect(meta.fields.map(({ name }) => name)).not.toContain("serviceAccess");
    expect(await users.userService.adminGet({ id: board.cy })).not.toHaveProperty("serviceAccess");
    await expect(
      users.userService.adminUpdate({
        id: board.cy,
        data: { serviceAccess: { taskService: "Admin" } },
      }),
    ).rejects.toMatchObject({ code: "VALIDATION" });
  });

  it("with grants: true, a service-wide Admin sees and edits a user's grants, and the user's sockets get them at once", async () => {
    const app = await start(grantingUsers);
    const board = kit.board();
    const users = callerOf(app, usersAdmin(board.ada));
    const meta = await users.userService.adminMeta(undefined);
    expect(meta.fields).toContainEqual(
      expect.objectContaining({ name: "serviceAccess", type: "json", editable: true }),
    );
    expect(await users.userService.adminGet({ id: board.cy })).toMatchObject({
      id: board.cy,
      serviceAccess: null,
    });
    const target = await app.connect(as(board.cy));
    const access: unknown[] = [];
    target.socket.on("qd:access", (frame: unknown) => access.push(frame));
    expect(
      await users.userService.adminUpdate({
        id: board.cy,
        data: { serviceAccess: { taskService: "Moderate" } },
      }),
    ).toMatchObject({ serviceAccess: { taskService: "Moderate" } });
    await emitWithAck(target.socket, "qd:unsub", { s: "none", ids: [] });
    expect(access).toEqual([{ serviceAccess: { taskService: "Moderate" } }]);
    const stored = await kit
      .harness()
      .prisma.user.findUnique({ where: { id: board.cy }, select: { serviceAccess: true } });
    expect(stored?.serviceAccess).toEqual({ taskService: "Moderate" });
  });

  it("checks the grants against the entity's schema", async () => {
    const app = await start(grantingUsers);
    const board = kit.board();
    await expect(
      callerOf(app, usersAdmin(board.ada)).userService.adminUpdate({
        id: board.cy,
        data: { serviceAccess: { taskService: "Owner" } },
      }),
    ).rejects.toMatchObject({ code: "VALIDATION" });
  });

  it("keeps grants from a caller below a service-wide Admin, whatever form the method runs under", async () => {
    const app = await start(grantingUsers);
    const board = kit.board();
    await kit.harness().prisma.user.update({
      where: { id: board.cy },
      data: { serviceAccess: { taskService: "Read" } },
    });
    const moderator = callerOf(app, as(board.bo, { userService: "Moderate" }));
    const row = await moderator.userService.adminGet({ id: board.cy });
    expect(row).toMatchObject({ id: board.cy });
    expect(row).not.toHaveProperty("serviceAccess");
    await expect(
      moderator.userService.adminUpdate({
        id: board.bo,
        data: { serviceAccess: { userService: "Admin" } },
      }),
    ).rejects.toMatchObject({ code: "FORBIDDEN" });
    // The rest of the row is theirs to edit under the lowered form.
    expect(
      await moderator.userService.adminUpdate({ id: board.cy, data: { name: "Cy Renamed" } }),
    ).toMatchObject({ name: "Cy Renamed" });
    // No grant at all: the method's own form refuses first.
    await expect(
      callerOf(app, as(board.di)).userService.adminGet({ id: board.cy }),
    ).rejects.toMatchObject({ code: "FORBIDDEN" });
  });

  it("marks the grants field kind: grants, and an override keeps it out of a generic form (finding F5.5)", async () => {
    const withEditor = qd.defineService(userContract, {
      model: "user",
      access: owner("id"),
      methods: {
        ...admin.handlers(userContract, {
          grants: true,
          // The app edits grants in a screen of its own.
          fieldOverrides: { serviceAccess: { showInForm: false } },
        }),
      },
    });
    for (const [service, shown] of [
      [grantingUsers, undefined],
      [withEditor, false],
    ] as const) {
      const app = await start(service);
      const board = kit.board();
      const meta = await callerOf(app, usersAdmin(board.ada)).userService.adminMeta(undefined);
      const grants = meta.fields.find((field) => field.name === "serviceAccess");
      expect(grants).toMatchObject({ kind: "grants", type: "json", editable: true });
      expect((grants as { readonly showInForm?: boolean }).showInForm).toBe(shown);
      // Only the grants field says what it holds, and no field is hidden from forms unasked.
      for (const field of meta.fields.filter((other) => other.name !== "serviceAccess")) {
        expect(field).not.toHaveProperty("kind");
        expect(field).not.toHaveProperty("showInForm");
      }
      // Kept out of a form, the field is still read and written for a grants editor.
      expect(
        await callerOf(app, usersAdmin(board.ada)).userService.adminUpdate({
          id: board.cy,
          data: { serviceAccess: { taskService: "Read" } },
        }),
      ).toMatchObject({ serviceAccess: { taskService: "Read" } });
    }
  });

  it("takes grants: true on any entity, and refuses anything but a boolean", () => {
    const note = z.object({ id: z.string(), text: z.string() });
    const noGrants = defineContract("noteService", {
      entity: note,
      methods: { ...adminContract.contract({ entity: note }) },
    });
    // Whether an entity has a grants field is known only with the server's grants source.
    expect(() => admin.handlers(noGrants, { grants: true })).not.toThrow();
    expect(() => admin.handlers(userContract, { grants: "yes" as unknown as boolean })).toThrow(
      "grants must be true or false",
    );
    expect(() =>
      admin.handlers(userContract, { grants: true, hiddenFields: ["serviceAccess"] }),
    ).toThrow('"serviceAccess" holds the grants that grants: true shows');
  });
});

describe("a grants column of another name (ADMIN-2)", () => {
  // The task model stands in for an app's users: grants live in `details`.
  const accountEntity = z.object({
    id: z.string(),
    title: z.string(),
    details: z.record(z.string(), level).nullable(),
  });
  const accountContract = defineContract("accountService", {
    entity: accountEntity,
    methods: { ...adminContract.contract({ entity: accountEntity, sort: ["title"] }) },
  });
  const lowered = {
    access: { adminGet: { service: "Moderate" }, adminUpdate: { service: "Moderate" } },
    rowless: ["adminGet", "adminUpdate"],
  } as const;
  const accountsOf = (options: Parameters<typeof admin.handlers<typeof accountContract>>[1]) =>
    qd.defineService(accountContract, {
      model: "task",
      access: owner("id"),
      methods: { ...admin.handlers(accountContract, options) },
    });

  type Source = { readonly model: string; readonly column: string };
  const detailsSource: Source = { model: "task", column: "details" };

  async function startAccounts(
    service: AnyService,
    source: Source | false = detailsSource,
  ): Promise<TestApp> {
    const { db, prisma } = kit.harness();
    const app = await createTestApp({
      services: [service],
      db,
      auth: {
        loadServiceAccess: async (userId) => {
          const row = await prisma.task.findUnique({
            where: { id: userId },
            select: { details: true },
          });
          return (row?.details ?? {}) as Record<string, z.infer<typeof level>>;
        },
        ...(source === false ? {} : { serviceAccessSource: source }),
      },
    });
    kit.track(app as unknown as TestApp);
    return app as unknown as TestApp;
  }

  type Accounts = {
    readonly accountService: {
      adminMeta(input: undefined): Promise<{
        readonly fields: readonly { readonly name: string; readonly kind?: string }[];
      }>;
      adminGet(input: { readonly id: string }): Promise<Record<string, unknown>>;
      adminList(input: {
        readonly page: number;
        readonly pageSize: number;
        readonly filter: Readonly<Record<string, unknown>>;
        readonly sort?: { readonly field: string; readonly direction: "asc" | "desc" };
      }): Promise<{ readonly items: readonly Record<string, unknown>[] }>;
      adminCreate(input: {
        readonly data: Readonly<Record<string, unknown>>;
      }): Promise<Record<string, unknown>>;
      adminUpdate(input: {
        readonly id: string;
        readonly data: Readonly<Record<string, unknown>>;
      }): Promise<Record<string, unknown>>;
    };
  };
  const accountsAs = (app: TestApp, principal: ReturnType<typeof as>): Accounts["accountService"] =>
    (app.as(principal) as unknown as Accounts).accountService;
  const takeOver = { details: { accountService: "Admin", projectService: "Admin" } };
  const detailsOf = async (id: string) =>
    (await kit.harness().prisma.task.findUniqueOrThrow({ where: { id } })).details;

  it("hides the column from every caller and every write without grants: true", async () => {
    const app = await startAccounts(accountsOf({}));
    const board = kit.board();
    const ada = accountsAs(app, as(board.ada, { accountService: "Admin" }));
    expect((await ada.adminMeta(undefined)).fields.map(({ name }) => name)).not.toContain(
      "details",
    );
    expect(await ada.adminGet({ id: board.t1 })).not.toHaveProperty("details");
    await expect(ada.adminUpdate({ id: board.t1, data: takeOver })).rejects.toMatchObject({
      code: "VALIDATION",
    });
    expect(await detailsOf(board.t1)).toBeNull();
  });

  it("keeps a user under a lowered form from writing their own grants (the audit's case)", async () => {
    const app = await startAccounts(accountsOf(lowered));
    const board = kit.board();
    await kit.harness().prisma.task.update({
      where: { id: board.t1 },
      data: { details: { accountService: "Moderate" } },
    });
    // The row is the user's own (owner("id")), and its grants say Moderate.
    const me = accountsAs(app, as(board.t1));
    await expect(me.adminMeta(undefined)).rejects.toMatchObject({ code: "FORBIDDEN" });
    await expect(me.adminUpdate({ id: board.t1, data: takeOver })).rejects.toMatchObject({
      code: "VALIDATION",
    });
    expect(await detailsOf(board.t1)).toEqual({ accountService: "Moderate" });
    await expect(me.adminMeta(undefined)).rejects.toMatchObject({ code: "FORBIDDEN" });
  });

  it("with grants: true, shows and writes the column for a service-wide Admin only", async () => {
    const app = await startAccounts(accountsOf({ ...lowered, grants: true }));
    const board = kit.board();
    await kit.harness().prisma.task.update({
      where: { id: board.t1 },
      data: { details: { accountService: "Moderate" } },
    });
    const ada = accountsAs(app, as(board.ada, { accountService: "Admin" }));
    expect((await ada.adminMeta(undefined)).fields).toContainEqual(
      expect.objectContaining({ name: "details", kind: "grants" }),
    );
    expect(
      await ada.adminUpdate({ id: board.t2, data: { details: { accountService: "Read" } } }),
    ).toMatchObject({ details: { accountService: "Read" } });
    const me = accountsAs(app, as(board.t1));
    expect(await me.adminGet({ id: board.t1 })).not.toHaveProperty("details");
    await expect(me.adminUpdate({ id: board.t1, data: takeOver })).rejects.toMatchObject({
      code: "FORBIDDEN",
    });
    expect(await detailsOf(board.t1)).toEqual({ accountService: "Moderate" });
  });

  it("fails when the server is made for options that clash with the column, and not without it", async () => {
    const hiding = () => accountsOf({ grants: true, hiddenFields: ["details"] });
    await expect(startAccounts(hiding())).rejects.toThrow("holds the grants");
    const editableContract = defineContract("accountService", {
      entity: accountEntity,
      methods: {
        ...adminContract.contract({ entity: accountEntity, editable: ["title", "details"] }),
      },
    });
    const editing = qd.defineService(editableContract, {
      model: "task",
      access: owner("id"),
      methods: { ...admin.handlers(editableContract) },
    });
    await expect(startAccounts(editing)).rejects.toThrow(
      '"details" is not a field of the entity the kit shows',
    );
    // Without a grants source, details is an ordinary field.
    await expect(
      startAccounts(accountsOf({ hiddenFields: ["details"] }), false),
    ).resolves.toBeDefined();
    await expect(startAccounts(editing, false)).resolves.toBeDefined();
  });

  it("checks grants: true when the server is made, where the grants column is known", async () => {
    const granting = accountsOf({ grants: true });
    await expect(startAccounts(granting, false)).rejects.toThrow(
      "grants: true needs a grants field",
    );
    await expect(startAccounts(granting)).resolves.toBeDefined();
  });

  it("leaves the column out of list rows, and refuses a create that names it", async () => {
    const app = await startAccounts(
      accountsOf({ access: { adminCreate: { service: "Moderate" } } }),
    );
    const board = kit.board();
    await kit.harness().prisma.task.update({
      where: { id: board.t1 },
      data: { details: { accountService: "Admin" } },
    });
    const ada = accountsAs(app, as(board.ada, { accountService: "Admin" }));
    const page = await ada.adminList({ page: 1, pageSize: 10, filter: {} });
    expect(page.items.length).toBeGreaterThan(0);
    expect(page.items.filter((item) => "details" in item)).toEqual([]);
    const me = accountsAs(app, as(board.t1, { accountService: "Moderate" }));
    await expect(
      me.adminCreate({ data: { title: "Mine", details: takeOver.details } }),
    ).rejects.toMatchObject({ code: "VALIDATION" });
  });

  it("leaves the kit alone when the grants column is on another model", async () => {
    const app = await startAccounts(accountsOf({}), { model: "user", column: "details" });
    const ada = accountsAs(app, as(kit.board().ada, { accountService: "Admin" }));
    expect((await ada.adminMeta(undefined)).fields.map(({ name }) => name)).toContain("details");
  });

  describe("that the kit sorts or filters on", () => {
    const titledContract = defineContract("accountService", {
      entity: accountEntity,
      methods: {
        ...adminContract.contract({ entity: accountEntity, sort: ["title"], filter: ["title"] }),
      },
    });
    const titledOf = (options: Parameters<typeof admin.handlers<typeof titledContract>>[1]) =>
      qd.defineService(titledContract, {
        model: "task",
        access: owner("id"),
        methods: { ...admin.handlers(titledContract, options) },
      });
    const titleSource = { model: "task", column: "title" };

    it("fails when the server is made, without grants: true", async () => {
      await expect(startAccounts(titledOf({}), titleSource)).rejects.toThrow(
        'createDispatcher: accountService: admin.handlers: "title" is hidden, so adminList may not filter or sort on it',
      );
    });

    it("with grants: true, is refused below a service-wide Admin, and the list sorts by id", async () => {
      const lowList = { grants: true, access: { adminList: { service: "Moderate" } } } as const;
      const app = await startAccounts(titledOf(lowList), titleSource);
      const board = kit.board();
      const me = accountsAs(app, as(board.t1, { accountService: "Moderate" }));
      const page = await me.adminList({ page: 1, pageSize: 10, filter: {} });
      expect(page.items.length).toBeGreaterThan(0);
      expect(page.items.filter((item) => "title" in item)).toEqual([]);
      await expect(
        me.adminList({ page: 1, pageSize: 10, filter: { title: "T1" } }),
      ).rejects.toMatchObject({ code: "FORBIDDEN" });
      await expect(
        me.adminList({
          page: 1,
          pageSize: 10,
          filter: {},
          sort: { field: "title", direction: "asc" },
        }),
      ).rejects.toMatchObject({ code: "FORBIDDEN" });
      const ada = accountsAs(app, as(board.ada, { accountService: "Admin" }));
      expect((await ada.adminList({ page: 1, pageSize: 10, filter: {} })).items[0]).toHaveProperty(
        "title",
      );
    });
  });

  describe("on a dispatcher made without createServer", () => {
    it("is createDispatcher's serviceAccessSource, hidden and guarded as on a server", async () => {
      const { db, prisma } = kit.harness();
      const board = kit.board();
      await prisma.task.update({
        where: { id: board.t1 },
        data: { details: { accountService: "Moderate" } },
      });
      const dispatcher = createDispatcher({
        services: [accountsOf(lowered)],
        db,
        serviceAccessSource: detailsSource,
      });
      expect(dispatcher.serviceAccessSource).toEqual(detailsSource);
      const me = (
        dispatcher.caller(as(board.t1, { accountService: "Moderate" })) as unknown as Accounts
      ).accountService;
      expect(await me.adminGet({ id: board.t1 })).not.toHaveProperty("details");
      await expect(me.adminUpdate({ id: board.t1, data: takeOver })).rejects.toMatchObject({
        code: "VALIDATION",
      });
      expect(await detailsOf(board.t1)).toEqual({ accountService: "Moderate" });
    });

    it("takes grants: true where it names the column, and refuses a source that is not { model, column }", () => {
      const { db } = kit.harness();
      const granting = accountsOf({ grants: true });
      expect(() => createDispatcher({ services: [granting], db })).toThrow(
        "grants: true needs a grants field",
      );
      expect(() =>
        createDispatcher({ services: [granting], db, serviceAccessSource: detailsSource }),
      ).not.toThrow();
      expect(() =>
        createDispatcher({
          services: [accountsOf({})],
          db,
          serviceAccessSource: { model: "task" } as unknown as Source,
        }),
      ).toThrow("createDispatcher: serviceAccessSource must be { model, column }");
    });

    it("serves HTTP through a router only when its dispatcher names the router's column (the audit's case)", async () => {
      const { db, prisma } = kit.harness();
      const board = kit.board();
      await prisma.task.update({
        where: { id: board.t1 },
        data: { details: { accountService: "Moderate" } },
      });
      const auth = {
        authenticate: ({ auth: given }: { readonly auth: { readonly token?: unknown } }) =>
          typeof given.token === "string" ? { userId: given.token } : null,
        loadServiceAccess: async (userId: string) =>
          ((await prisma.task.findUnique({ where: { id: userId }, select: { details: true } }))
            ?.details ?? {}) as Record<string, z.infer<typeof level>>,
        serviceAccessSource: detailsSource,
      };
      const unnamed = createDispatcher({ services: [accountsOf(lowered)], db });
      expect(() => createHttpRouter({ dispatcher: unnamed, auth })).toThrow(
        "createHttpRouter: auth.serviceAccessSource names task.details, but its dispatcher was made without one",
      );
      const named = createDispatcher({
        services: [accountsOf(lowered)],
        db,
        serviceAccessSource: detailsSource,
      });
      const router: HttpRouter = createHttpRouter({ dispatcher: named, auth });
      const httpServer = createHttpServer(router as never);
      await new Promise<void>((resolve) => {
        httpServer.listen(0, "127.0.0.1", resolve);
      });
      try {
        const { port } = httpServer.address() as AddressInfo;
        const reply = await fetch(
          `http://127.0.0.1:${String(port)}/qd/accountService/adminUpdate`,
          {
            method: "POST",
            headers: { "content-type": "application/json", authorization: `Bearer ${board.t1}` },
            body: JSON.stringify({ id: board.t1, data: takeOver }),
          },
        );
        expect(await reply.json()).toMatchObject({ ok: false, e: { code: "VALIDATION" } });
        expect(await detailsOf(board.t1)).toEqual({ accountService: "Moderate" });
      } finally {
        await new Promise((resolve) => {
          httpServer.close(resolve);
        });
      }
    });

    it("is auth.serviceAccessSource on createServer, which gives it to its dispatcher", async () => {
      const { db } = kit.harness();
      await expect(
        createTestApp({
          services: [accountsOf({})],
          db,
          serviceAccessSource: detailsSource,
        } as unknown as Parameters<typeof createTestApp>[0]),
      ).rejects.toThrow("createServer: name the grants column as auth.serviceAccessSource");
      const app = await startAccounts(accountsOf({}));
      expect(app.server.dispatcher.serviceAccessSource).toEqual(detailsSource);
    });
  });
});

describe("grants without auth.serviceAccessSource", () => {
  it("warns when the server is made: a lowered grant would stay on open sockets until they connect again", async () => {
    const { db } = kit.harness();
    const logger = captureLogger();
    const unsourced = await createTestApp({ services: [grantingUsers], db, logger });
    kit.track(unsourced as unknown as TestApp);
    expect(logger.at("warn").map((entry) => entry.message)).toEqual([
      "createServer: userService edit users' service-wide grants (the admin kit's grants: true), but auth.serviceAccessSource does not name where they are stored, so a user whose grant is lowered keeps it on open sockets until they connect again. Set auth.serviceAccessSource: { model, column }",
    ]);
    // Not for a kit that leaves grants alone, nor with the source named.
    const quiet = captureLogger();
    kit.track(
      (await createTestApp({ services: [plainUsers], db, logger: quiet })) as unknown as TestApp,
    );
    const sourced = await createTestApp({
      services: [grantingUsers],
      db,
      logger: quiet,
      auth: {
        loadServiceAccess: () => ({}),
        serviceAccessSource: { model: "user", column: "serviceAccess" },
      },
    });
    kit.track(sourced as unknown as TestApp);
    expect(quiet.at("warn")).toEqual([]);
  });
});
