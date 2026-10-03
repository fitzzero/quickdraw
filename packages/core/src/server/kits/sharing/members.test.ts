// The sharing kit's membership methods (RFC 0003 section 12.3, mode
// `"members"`) through a real server against PGlite and real sockets: an
// invite puts the row in the invitee's `via` collection (`added`), a remove
// or a leave takes it out (`removed`) and revokes their live subscriptions,
// all from the tracked writes' flush; the last Admin member stays; roles are
// the policy's own; members page by keyset cursor. Access is in
// `access.test.ts`.

import { describe, expect, it } from "vitest";
import { defineContract, type CollectionFrame } from "../../../index";
import { createTestApp, emitWithAck, type TestApp } from "../../../testing/index";
import { qd } from "../../access/__tests__/board";
import { members, sharing } from "../../index";
import {
  as,
  projectEntity,
  sharingApp,
  subscribeMine,
  subscribeProjects,
} from "./__tests__/fixture";

const kit = sharingApp();

type App = Awaited<ReturnType<typeof kit.start>>["app"];

/** The deltas of `mine` the user's sockets were sent, in order. */
function mineDeltas(app: App, userId: string) {
  return app
    .frames({ event: "qd:c", userId })
    .map((frame) => frame.data as CollectionFrame)
    .filter((frame) => frame.c === "mine")
    .flatMap((frame) => frame.deltas);
}

/** The roles the membership table stores for P1, by user. */
async function storedRoles(projectId: string): Promise<Record<string, string>> {
  const rows = await kit.harness().prisma.projectMember.findMany({ where: { projectId } });
  return Object.fromEntries(rows.map((row) => [row.userId, row.role]));
}

describe("invite, remove and leave", () => {
  it("puts the row in the invitee's mine collection as added, and remove sends removed", async () => {
    const { app } = await kit.start();
    const board = kit.board();
    const connection = await app.connect(as(board.gus));
    expect(await subscribeMine(connection, board.gus)).toMatchObject({ ok: true, items: [] });
    const owner = app.as(as(board.ada)).projectService;

    expect(await owner.invite({ entryId: board.p1, userId: board.gus })).toEqual({
      userId: board.gus,
      role: "Read",
      level: "Read",
    });
    await app.frames.waitFor({ event: "qd:c", userId: board.gus });
    expect(mineDeltas(app, board.gus)).toEqual([
      { t: "added", item: { id: board.p1, name: "P1", ownerId: board.ada } },
    ]);
    expect(await app.as(as(board.gus)).projectService.get({ id: board.p1 })).toMatchObject({
      id: board.p1,
    });

    app.frames.clear();
    expect(await owner.remove({ entryId: board.p1, userId: board.gus })).toBeNull();
    await app.frames.waitFor({ event: "qd:c", userId: board.gus });
    expect(mineDeltas(app, board.gus)).toEqual([{ t: "removed", id: board.p1 }]);
    await expect(app.as(as(board.gus)).projectService.get({ id: board.p1 })).rejects.toMatchObject({
      code: "FORBIDDEN",
    });
  });

  it("leave takes the row out of the member's collection and revokes their subscription to it", async () => {
    const { app } = await kit.start();
    const board = kit.board();
    const connection = await app.connect(as(board.cy));
    expect(await subscribeMine(connection, board.cy)).toMatchObject({
      items: [{ id: board.p1, name: "P1", ownerId: board.ada }],
    });
    expect(await subscribeProjects(connection, [board.p1])).toMatchObject({ r: [{ ok: true }] });

    expect(await app.as(as(board.cy)).projectService.leave({ entryId: board.p1 })).toBeNull();
    const revoked = await app.frames.waitFor({ event: "qd:revoked", userId: board.cy });
    expect(revoked.data).toEqual({
      kind: "entity",
      reason: "access",
      s: "projectService",
      id: board.p1,
    });
    await app.frames.waitFor({ event: "qd:c", userId: board.cy });
    expect(mineDeltas(app, board.cy)).toEqual([{ t: "removed", id: board.p1 }]);
    expect(await storedRoles(board.p1)).not.toHaveProperty(board.cy);

    // A later write to the row sends the former member nothing.
    await app.server.dispatcher.run(async () => {
      await kit.harness().db.project.update({ where: { id: board.p1 }, data: { name: "Renamed" } });
    });
    await expect(app.as(as(board.cy)).projectService.get({ id: board.p1 })).rejects.toMatchObject({
      code: "FORBIDDEN",
    });
    expect(app.frames({ event: "qd:e", userId: board.cy })).toEqual([]);
  });

  it("remove revokes the removed member's live subscription", async () => {
    const { app } = await kit.start();
    const board = kit.board();
    const connection = await app.connect(as(board.bo));
    await subscribeProjects(connection, [board.p1]);
    await app.as(as(board.fay)).projectService.remove({ entryId: board.p1, userId: board.bo });
    const revoked = await app.frames.waitFor({ event: "qd:revoked", userId: board.bo });
    expect(revoked.data).toMatchObject({ kind: "entity", s: "projectService", id: board.p1 });
  });

  it("leave is for members only: FORBIDDEN for anyone else", async () => {
    const { app } = await kit.start();
    const board = kit.board();
    // The owner and di have access through the access list, not the table.
    for (const userId of [board.ada, board.di, board.gus]) {
      await expect(
        app.as(as(userId)).projectService.leave({ entryId: board.p1 }),
      ).rejects.toMatchObject({ code: "FORBIDDEN" });
    }
    await expect(
      app.as(as(board.cy)).projectService.leave({ entryId: board.p2 }),
    ).rejects.toMatchObject({ code: "FORBIDDEN" });
  });

  it("finds the invitee by name or email with resolveUser; no such user is NOT_FOUND", async () => {
    const { app } = await kit.start();
    const board = kit.board();
    const owner = app.as(as(board.ada)).projectService;
    expect(await owner.inviteByName({ entryId: board.p1, name: "Gus", role: "Moderate" })).toEqual({
      userId: board.gus,
      role: "Moderate",
      level: "Moderate",
    });
    const { email } = await kit
      .harness()
      .prisma.user.findUniqueOrThrow({ where: { id: board.di } });
    expect(await owner.inviteByName({ entryId: board.p1, email })).toMatchObject({
      userId: board.di,
    });
    await expect(owner.inviteByName({ entryId: board.p1, name: "Nobody" })).rejects.toMatchObject({
      code: "NOT_FOUND",
    });
  });
});

describe("the last Admin member", () => {
  it("cannot leave, be removed or lose Admin until another member has it", async () => {
    const { app } = await kit.start();
    const board = kit.board();
    const fay = app.as(as(board.fay)).projectService;
    const owner = app.as(as(board.ada)).projectService;
    for (const call of [
      fay.leave({ entryId: board.p1 }),
      owner.remove({ entryId: board.p1, userId: board.fay }),
      owner.setRole({ entryId: board.p1, userId: board.fay, role: "Moderate" }),
      fay.setRole({ entryId: board.p1, userId: board.fay, role: "Read" }),
    ]) {
      await expect(call).rejects.toMatchObject({
        code: "CONFLICT",
        message: expect.stringContaining("last Admin member"),
      });
    }
    // Only this table's Admin members count: the owner's Admin from the access list does not.
    expect(await storedRoles(board.p1)).toMatchObject({ [board.fay]: "Admin" });

    await owner.setRole({ entryId: board.p1, userId: board.bo, role: "Admin" });
    expect(await fay.setRole({ entryId: board.p1, userId: board.fay, role: "Read" })).toEqual({
      userId: board.fay,
      role: "Read",
      level: "Read",
    });
    await expect(
      app.as(as(board.bo)).projectService.leave({ entryId: board.p1 }),
    ).rejects.toMatchObject({ code: "CONFLICT" });
    expect(await fay.leave({ entryId: board.p1 })).toBeNull();
  });

  it("does not hold back changes to members who are not Admin", async () => {
    const { app } = await kit.start();
    const board = kit.board();
    const fay = app.as(as(board.fay)).projectService;
    expect(await fay.setRole({ entryId: board.p1, userId: board.cy, role: "Moderate" })).toEqual({
      userId: board.cy,
      role: "Moderate",
      level: "Moderate",
    });
    expect(await fay.remove({ entryId: board.p1, userId: board.bo })).toBeNull();
    expect(await storedRoles(board.p1)).toEqual({ [board.cy]: "Moderate", [board.fay]: "Admin" });
  });
});

describe("invite and setRole", () => {
  it("refuses a member, a role the policy cannot read, and a user the database does not know", async () => {
    const { app } = await kit.start();
    const board = kit.board();
    const owner = app.as(as(board.ada)).projectService;
    await expect(owner.invite({ entryId: board.p1, userId: board.cy })).rejects.toMatchObject({
      code: "CONFLICT",
    });
    await expect(
      owner.invite({ entryId: board.p1, userId: board.gus, role: "Owner" }),
    ).rejects.toMatchObject({
      code: "VALIDATION",
      data: { issues: [{ path: ["role"], message: expect.stringContaining('"Owner"') }] },
    });
    await expect(
      owner.invite({ entryId: board.p1, userId: board.gus, role: "Public" }),
    ).rejects.toMatchObject({ code: "VALIDATION" });
    await expect(owner.invite({ entryId: board.p1, userId: "nobody" })).rejects.toMatchObject({
      code: "NOT_FOUND",
    });
    expect(await storedRoles(board.p1)).not.toHaveProperty(board.gus);
  });

  it("changes a member's role, needs a member, and writes nothing for the same role", async () => {
    const { app } = await kit.start();
    const board = kit.board();
    const owner = app.as(as(board.ada)).projectService;
    await expect(
      owner.setRole({ entryId: board.p1, userId: board.gus, role: "Read" }),
    ).rejects.toMatchObject({ code: "NOT_FOUND" });
    await expect(
      owner.setRole({ entryId: board.p1, userId: board.cy, role: "Owner" }),
    ).rejects.toMatchObject({ code: "VALIDATION" });
    const { storage } = kit.harness();
    const admin = app.as(as(board.ed, { projectService: "Admin" })).projectService;
    const same = await storage.countStatements(() =>
      admin.setRole({ entryId: board.p1, userId: board.cy, role: "Read" }),
    );
    // The member's rows, and nothing written.
    expect(same).toEqual({
      value: { userId: board.cy, role: "Read", level: "Read" },
      statements: 1,
    });
    expect(await owner.setRole({ entryId: board.p1, userId: board.cy, role: "Moderate" })).toEqual({
      userId: board.cy,
      role: "Moderate",
      level: "Moderate",
    });
    expect(await storedRoles(board.p1)).toMatchObject({ [board.cy]: "Moderate" });
  });
});

describe("listMembers", () => {
  it("pages a row's members in user id order by keyset cursor", async () => {
    const { app } = await kit.start();
    const board = kit.board();
    const reader = app.as(as(board.cy)).projectService;
    const first = await reader.listMembers({ entryId: board.p1, limit: 2 });
    const second = await reader.listMembers({
      entryId: board.p1,
      limit: 2,
      cursor: first.nextCursor ?? "",
    });
    const expected = [
      { userId: board.bo, role: "Moderate", level: "Moderate" },
      { userId: board.cy, role: "Read", level: "Read" },
      { userId: board.fay, role: "Admin", level: "Admin" },
    ].sort((a, b) => (a.userId < b.userId ? -1 : 1));
    expect(first.items).toEqual(expected.slice(0, 2));
    expect(second).toEqual({ items: expected.slice(2), nextCursor: null });
    expect(await reader.listMembers({ entryId: board.p1 })).toEqual({
      items: expected,
      nextCursor: null,
    });
    expect(await app.as(as(board.ed)).projectService.listMembers({ entryId: board.p2 })).toEqual({
      items: [],
      nextCursor: null,
    });
    await expect(
      reader.listMembers({ entryId: board.p1, cursor: "not-a-cursor" }),
    ).rejects.toMatchObject({ code: "VALIDATION" });
  });
});

describe("roles the policy maps to levels", () => {
  const teams = defineContract("teamService", {
    entity: projectEntity,
    methods: { ...sharing.contract({ mode: "members" }) },
  });
  const teamService = qd.defineService(teams, {
    model: "project",
    access: members({
      model: "projectMember",
      entry: "projectId",
      user: "userId",
      level: "role",
      levels: { owner: "Admin", editor: "Moderate", viewer: "Read", guest: "Public" },
    }),
    methods: { ...sharing.handlers(teams) },
  });

  it("gives the lowest readable role by default, refuses level names, and reports levels", async () => {
    const app = await createTestApp({ services: [teamService], db: kit.harness().db });
    kit.track(app as unknown as TestApp);
    const board = kit.board();
    await kit.harness().prisma.projectMember.create({
      data: { projectId: board.p2, userId: board.ed, role: "owner" },
    });
    const ed = app.as(as(board.ed)).teamService;
    expect(await ed.invite({ entryId: board.p2, userId: board.gus })).toEqual({
      userId: board.gus,
      role: "viewer",
      level: "Read",
    });
    await expect(
      ed.invite({ entryId: board.p2, userId: board.cy, role: "Admin" }),
    ).rejects.toMatchObject({ code: "VALIDATION" });
    expect(await ed.invite({ entryId: board.p2, userId: board.cy, role: "guest" })).toEqual({
      userId: board.cy,
      role: "guest",
      level: "Public",
    });
    await expect(ed.leave({ entryId: board.p2 })).rejects.toMatchObject({ code: "CONFLICT" });
    await ed.setRole({ entryId: board.p2, userId: board.gus, role: "owner" });
    expect(await ed.leave({ entryId: board.p2 })).toBeNull();
    expect(
      (await app.as(as(board.gus)).teamService.listMembers({ entryId: board.p2 })).items,
    ).toContainEqual({ userId: board.gus, role: "owner", level: "Admin" });
  });

  it("revokes a live subscription when a role change leaves the member below Read", async () => {
    const app = await createTestApp({ services: [teamService], db: kit.harness().db });
    kit.track(app as unknown as TestApp);
    const board = kit.board();
    await kit.harness().prisma.projectMember.createMany({
      data: [
        { projectId: board.p2, userId: board.ed, role: "owner" },
        { projectId: board.p2, userId: board.gus, role: "viewer" },
      ],
    });
    const connection = await app.connect(as(board.gus));
    expect(
      await emitWithAck(connection.socket, "qd:sub", { s: "teamService", ids: [board.p2] }),
    ).toMatchObject({ r: [{ ok: true }] });

    await app
      .as(as(board.ed))
      .teamService.setRole({ entryId: board.p2, userId: board.gus, role: "guest" });
    const revoked = await app.frames.waitFor({ event: "qd:revoked", userId: board.gus });
    expect(revoked.data).toEqual({
      kind: "entity",
      reason: "access",
      s: "teamService",
      id: board.p2,
    });
  });
});

describe("statements", () => {
  it("costs one read and the write for most changes, one more when Admin is taken away", async () => {
    const { app } = await kit.start();
    const board = kit.board();
    const { storage } = kit.harness();
    const count = async (call: () => Promise<unknown>) =>
      (await storage.countStatements(call)).statements;
    // A service-wide Admin grant needs no access read: the handler's own statements only.
    const admin = app.as(as(board.ed, { projectService: "Admin" })).projectService;
    // Whether the user is a member, then the create.
    expect(await count(() => admin.invite({ entryId: board.p1, userId: board.gus }))).toBe(2);
    // The member's rows, then updateMany, which reads the old roles first.
    expect(
      await count(() => admin.setRole({ entryId: board.p1, userId: board.gus, role: "Admin" })),
    ).toBe(3);
    // Taking Admin away also asks whether another member has it.
    expect(
      await count(() => admin.setRole({ entryId: board.p1, userId: board.gus, role: "Read" })),
    ).toBe(4);
    // The member's rows, then the delete.
    expect(await count(() => admin.remove({ entryId: board.p1, userId: board.gus }))).toBe(2);
    expect(await count(() => admin.listMembers({ entryId: board.p1 }))).toBe(1);
  });
});
