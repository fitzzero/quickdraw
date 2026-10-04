// The admin kit and users' service-wide grants (finding F2.3 of the
// quickdraw-chat migration): `serviceAccess` stays hidden and unwritten by
// default; `admin.handlers(contract, { grants: true })` shows and writes it,
// for callers whose own service-wide grant is `Admin` only, whatever form a
// method runs under; the write is a tracked write of the grants column, so
// with `auth.serviceAccessSource` the user's open sockets get their new
// grants at once.

import { describe, expect, it } from "vitest";
import { z } from "zod";
import { admin as adminContract, defineContract } from "../../../index";
import { createTestApp, emitWithAck, type TestApp } from "../../../testing/index";
import { qd } from "../../emit/__tests__/live";
import { admin, owner } from "../../index";
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

  it("is refused for an entity without a grants field, and with anything but a boolean", () => {
    const note = z.object({ id: z.string(), text: z.string() });
    const noGrants = defineContract("noteService", {
      entity: note,
      methods: { ...adminContract.contract({ entity: note }) },
    });
    expect(() => admin.handlers(noGrants, { grants: true as never })).toThrow(
      "grants: the entity has no serviceAccess or service_access field",
    );
    expect(() => admin.handlers(userContract, { grants: "yes" as unknown as boolean })).toThrow(
      "grants must be true or false",
    );
    expect(() =>
      admin.handlers(userContract, { grants: true, hiddenFields: ["serviceAccess"] }),
    ).toThrow('"serviceAccess" holds the grants that grants: true shows');
  });
});
