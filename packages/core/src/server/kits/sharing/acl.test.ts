// The sharing kit's access list methods (RFC 0003 section 12.3, mode
// `"acl"`) through a real server against PGlite and real sockets: a share
// lets the user read and subscribe at once, an unshare revokes their live
// subscription (the tracked write evicts and revokes; the kit sends
// nothing), and the list's invariants hold: the owner's access never
// changes, a list without an owner keeps its last Admin, and a malformed
// list is reported, never overwritten. Access is in `access.test.ts`.

import { describe, expect, it } from "vitest";
import { defineContract } from "../../../index";
import { createTestApp, type TestApp } from "../../../testing/index";
import { qd } from "../../access/__tests__/board";
import { jsonAcl, sharing } from "../../index";
import { as, projectEntity, sharingApp, subscribeProjects } from "./__tests__/fixture";

const kit = sharingApp();

/** The access list P1 holds in the database. */
async function storedAcl(id: string): Promise<unknown> {
  const row = await kit.harness().prisma.project.findUniqueOrThrow({ where: { id } });
  return row.acl;
}

describe("share", () => {
  it("lets the user read the row and subscribe to it at once", async () => {
    const { app } = await kit.start();
    const board = kit.board();
    const gus = app.as(as(board.gus)).projectService;
    await expect(gus.get({ id: board.p1 })).rejects.toMatchObject({ code: "FORBIDDEN" });
    const connection = await app.connect(as(board.gus));
    expect(await subscribeProjects(connection, [board.p1])).toMatchObject({
      ok: true,
      r: [{ ok: false, e: { code: "FORBIDDEN" } }],
    });

    const list = await app
      .as(as(board.ada))
      .projectService.share({ id: board.p1, userId: board.gus, level: "Read" });
    expect(list).toEqual([
      { userId: board.di, level: "Read" },
      { userId: board.gus, level: "Read" },
    ]);
    expect(await storedAcl(board.p1)).toEqual([
      { userId: board.di, level: "Read" },
      { userId: board.gus, level: "Read" },
    ]);
    expect(await gus.get({ id: board.p1 })).toEqual({
      id: board.p1,
      name: "P1",
      ownerId: board.ada,
    });
    expect(await subscribeProjects(connection, [board.p1])).toMatchObject({
      ok: true,
      r: [{ ok: true, d: { id: board.p1, name: "P1", ownerId: board.ada } }],
    });
  });

  it("replaces a level, and keeps the other keys an app stores in the entry", async () => {
    const { app } = await kit.start();
    const board = kit.board();
    await kit.harness().prisma.project.update({
      where: { id: board.p1 },
      data: {
        acl: [
          { userId: board.di, level: "Read", addedAt: "2026-10-01" },
          { userId: board.bo, level: "Read" },
          { userId: board.di, level: "Moderate" },
        ],
      },
    });
    const owner = app.as(as(board.ada)).projectService;
    // Several entries for one user count as their highest, as the policy reads them.
    expect(await owner.listShares({ id: board.p1 })).toEqual([
      { userId: board.di, level: "Moderate" },
      { userId: board.bo, level: "Read" },
    ]);
    expect(await owner.share({ id: board.p1, userId: board.di, level: "Admin" })).toEqual([
      { userId: board.di, level: "Admin" },
      { userId: board.bo, level: "Read" },
    ]);
    expect(await storedAcl(board.p1)).toEqual([
      { userId: board.di, level: "Admin", addedAt: "2026-10-01" },
      { userId: board.bo, level: "Read" },
    ]);
  });

  it("writes nothing when the user has that level already", async () => {
    const { app } = await kit.start();
    const board = kit.board();
    const connection = await app.connect(as(board.ada));
    await subscribeProjects(connection, [board.p1]);
    app.frames.clear();
    const owner = app.as(as(board.ada)).projectService;
    expect(await owner.share({ id: board.p1, userId: board.di, level: "Read" })).toEqual([
      { userId: board.di, level: "Read" },
    ]);
    expect(await owner.setLevel({ id: board.p1, userId: board.di, level: "Read" })).toEqual([
      { userId: board.di, level: "Read" },
    ]);
    expect(app.frames({ event: "qd:e" })).toEqual([]);
  });

  it("finds the user by name or email with resolveUser; no such user is NOT_FOUND", async () => {
    const { app } = await kit.start();
    const board = kit.board();
    const owner = app.as(as(board.ada)).projectService;
    expect(await owner.shareByName({ id: board.p1, name: "Gus", level: "Moderate" })).toEqual([
      { userId: board.di, level: "Read" },
      { userId: board.gus, level: "Moderate" },
    ]);
    const { email } = await kit
      .harness()
      .prisma.user.findUniqueOrThrow({ where: { id: board.ed } });
    expect(await owner.shareByName({ id: board.p1, email, level: "Read" })).toContainEqual({
      userId: board.ed,
      level: "Read",
    });
    await expect(
      owner.shareByName({ id: board.p1, name: "Nobody", level: "Read" }),
    ).rejects.toMatchObject({ code: "NOT_FOUND", message: "No such user" });
    await expect(owner.shareByName({ id: board.p1, level: "Read" })).rejects.toMatchObject({
      code: "VALIDATION",
    });
  });
});

describe("unshare", () => {
  it("revokes the user's live subscription, which gets no further frames", async () => {
    const { app } = await kit.start();
    const board = kit.board();
    const reader = await app.connect(as(board.di));
    const owner = await app.connect(as(board.ada));
    expect(await subscribeProjects(reader, [board.p1])).toMatchObject({ r: [{ ok: true }] });
    await subscribeProjects(owner, [board.p1]);

    expect(
      await app.as(as(board.ada)).projectService.unshare({ id: board.p1, userId: board.di }),
    ).toEqual([]);
    const revoked = await app.frames.waitFor({ event: "qd:revoked", userId: board.di });
    expect(revoked.data).toEqual({
      kind: "entity",
      reason: "access",
      s: "projectService",
      id: board.p1,
    });

    // A later write reaches the owner's subscription, and nothing more reaches the reader's.
    await app.server.dispatcher.run(async () => {
      await kit.harness().db.project.update({ where: { id: board.p1 }, data: { name: "Renamed" } });
    });
    await app.frames.waitFor(
      (frame) =>
        frame.event === "qd:e" &&
        frame.userId === board.ada &&
        JSON.stringify(frame.data).includes("Renamed"),
    );
    expect(app.frames({ userId: board.di }).map((frame) => frame.event)).toEqual([
      "qd:hello",
      "qd:revoked",
    ]);
    await expect(app.as(as(board.di)).projectService.get({ id: board.p1 })).rejects.toMatchObject({
      code: "FORBIDDEN",
    });
    expect(await subscribeProjects(reader, [board.p1])).toMatchObject({
      r: [{ ok: false, e: { code: "FORBIDDEN" } }],
    });
  });

  it("needs the user in the list, as setLevel does", async () => {
    const { app } = await kit.start();
    const board = kit.board();
    const owner = app.as(as(board.ada)).projectService;
    await expect(owner.unshare({ id: board.p1, userId: board.gus })).rejects.toMatchObject({
      code: "NOT_FOUND",
    });
    await expect(
      owner.setLevel({ id: board.p1, userId: board.gus, level: "Read" }),
    ).rejects.toMatchObject({ code: "NOT_FOUND" });
    expect(await owner.setLevel({ id: board.p1, userId: board.di, level: "Moderate" })).toEqual([
      { userId: board.di, level: "Moderate" },
    ]);
  });
});

describe("the list's invariants", () => {
  it("never changes the owner's access", async () => {
    const { app } = await kit.start();
    const board = kit.board();
    const owner = app.as(as(board.ada)).projectService;
    const calls = [
      owner.share({ id: board.p1, userId: board.ada, level: "Read" }),
      owner.setLevel({ id: board.p1, userId: board.ada, level: "Read" }),
      owner.unshare({ id: board.p1, userId: board.ada }),
    ];
    for (const call of calls) {
      await expect(call).rejects.toMatchObject({ code: "CONFLICT" });
    }
    expect(await storedAcl(board.p1)).toEqual([{ userId: board.di, level: "Read" }]);
  });

  it("keeps the last Admin of a list without an owner column", async () => {
    const docs = defineContract("docService", {
      entity: projectEntity,
      methods: { ...sharing.contract({ mode: "acl" }) },
    });
    const docService = qd.defineService(docs, {
      model: "project",
      access: jsonAcl("acl"),
      methods: { ...sharing.handlers(docs) },
    });
    const app = await createTestApp({ services: [docService], db: kit.harness().db });
    kit.track(app as unknown as TestApp);
    const board = kit.board();
    // Nobody has Admin on P2 through its list yet: a service-wide grant shares it.
    const grant = app.as(as(board.gus, { docService: "Admin" })).docService;
    await grant.share({ id: board.p2, userId: board.ed, level: "Admin" });

    const ed = app.as(as(board.ed)).docService;
    for (const call of [
      ed.unshare({ id: board.p2, userId: board.ed }),
      ed.setLevel({ id: board.p2, userId: board.ed, level: "Moderate" }),
      ed.share({ id: board.p2, userId: board.ed, level: "Read" }),
    ]) {
      await expect(call).rejects.toMatchObject({ code: "CONFLICT" });
    }
    await ed.share({ id: board.p2, userId: board.cy, level: "Admin" });
    expect(await ed.unshare({ id: board.p2, userId: board.ed })).toEqual([
      { userId: board.cy, level: "Admin" },
    ]);
  });

  it("reports a malformed list and leaves it as it is", async () => {
    const { app } = await kit.start();
    const board = kit.board();
    const owner = app.as(as(board.ada)).projectService;
    const prisma = kit.harness().prisma;
    for (const acl of [
      { userId: board.di, level: "Read" },
      [{ userId: board.di, level: "Owner" }],
      [{ userId: board.di, level: "Read" }, "Read"],
      [{ user: board.di, level: "Read" }],
    ]) {
      await prisma.project.update({ where: { id: board.p1 }, data: { acl } });
      await expect(
        owner.share({ id: board.p1, userId: board.gus, level: "Read" }),
      ).rejects.toMatchObject({ code: "CONFLICT", message: expect.stringContaining("malformed") });
      await expect(owner.unshare({ id: board.p1, userId: board.di })).rejects.toMatchObject({
        code: "CONFLICT",
      });
      await expect(owner.listShares({ id: board.p1 })).rejects.toMatchObject({ code: "CONFLICT" });
      expect(await storedAcl(board.p1)).toEqual(acl);
    }
  });

  it("treats a row without a list as an empty one", async () => {
    const { app } = await kit.start();
    const board = kit.board();
    const ed = app.as(as(board.ed)).projectService;
    expect(await ed.listShares({ id: board.p2 })).toEqual([]);
    expect(await ed.share({ id: board.p2, userId: board.gus, level: "Read" })).toEqual([
      { userId: board.gus, level: "Read" },
    ]);
  });

  it("answers NOT_FOUND for a row that is not there", async () => {
    const { app } = await kit.start();
    const board = kit.board();
    const admin = app.as(as(board.gus, { projectService: "Admin" })).projectService;
    await expect(
      admin.share({ id: "missing", userId: board.gus, level: "Read" }),
    ).rejects.toMatchObject({ code: "NOT_FOUND" });
    await expect(admin.listShares({ id: "missing" })).rejects.toMatchObject({ code: "NOT_FOUND" });
  });
});

describe("statements", () => {
  it("costs three statements for a change and one for listShares", async () => {
    const { app } = await kit.start();
    const board = kit.board();
    const { storage } = kit.harness();
    const count = async (call: () => Promise<unknown>) =>
      (await storage.countStatements(call)).statements;
    // A service-wide Admin grant needs no access read: the handler's own statements only.
    const admin = app.as(as(board.gus, { projectService: "Admin" })).projectService;
    // The row and its list, then the tracked update, which reads the old access columns first.
    expect(await count(() => admin.share({ id: board.p1, userId: board.gus, level: "Read" }))).toBe(
      3,
    );
    expect(await count(() => admin.unshare({ id: board.p1, userId: board.gus }))).toBe(3);
    expect(await count(() => admin.listShares({ id: board.p1 }))).toBe(1);
    // Nothing to write: the read only.
    expect(await count(() => admin.share({ id: board.p1, userId: board.di, level: "Read" }))).toBe(
      1,
    );
  });
});
