// The sharing kit's access (RFC 0003 sections 4 and 12.3), through a real
// server against PGlite: the access matrix of every kit method, over real
// sockets, for P1's owner, its Admin member, a Read member, a stranger and
// an anonymous caller, then the forms an app gives in place of the defaults.
// Verify these first: the kit changes who can see what, so its defaults are
// the security surface. A change needs Admin on the row, a list Read, and
// `leave` a member.

import { describe, expect, it } from "vitest";
import { defineContract } from "../../../index";
import { createTestApp, describeAccessMatrix, type TestApp } from "../../../testing/index";
import { qd } from "../../access/__tests__/board";
import { anyOf, jsonAcl, sharing } from "../../index";
import { as, projectEntity, projectMembers, sharingApp } from "./__tests__/fixture";

const kit = sharingApp();

function principals() {
  const board = kit.board();
  return {
    owner: as(board.ada),
    adminMember: as(board.fay),
    readMember: as(board.cy),
    stranger: as(board.ed),
  };
}

describe("the access matrix", () => {
  it("runs every kit method as the owner, an Admin member, a Read member, a stranger and anonymously", async () => {
    const { app, service } = await kit.start();
    const board = kit.board();
    const { p1, gus } = board;
    // A change runs for real, once per principal it lets through, in this
    // order: the owner first, then the Admin member, whose repeat of a
    // change the owner made already shows it passed the access check.
    const report = await describeAccessMatrix(app, {
      service,
      principals: principals(),
      via: "socket",
      cases: [
        { method: "listShares", input: { id: p1 }, allow: ["owner", "adminMember", "readMember"] },
        {
          method: "listMembers",
          input: { entryId: p1 },
          allow: ["owner", "adminMember", "readMember"],
        },
        {
          method: "share",
          input: { id: p1, userId: gus, level: "Read" },
          allow: ["owner", "adminMember"],
        },
        {
          method: "shareByName",
          input: { id: p1, name: "Gus", level: "Read" },
          allow: ["owner", "adminMember"],
        },
        {
          method: "setLevel",
          input: { id: p1, userId: gus, level: "Moderate" },
          allow: ["owner", "adminMember"],
        },
        {
          method: "unshare",
          input: { id: p1, userId: gus },
          allow: ["owner"],
          expect: { adminMember: "NOT_FOUND" },
        },
        {
          method: "invite",
          input: { entryId: p1, userId: gus },
          allow: ["owner"],
          expect: { adminMember: "CONFLICT" },
        },
        {
          method: "setRole",
          input: { entryId: p1, userId: gus, role: "Moderate" },
          allow: ["owner", "adminMember"],
        },
        {
          method: "remove",
          input: { entryId: p1, userId: gus },
          allow: ["owner"],
          expect: { adminMember: "NOT_FOUND" },
        },
        {
          method: "inviteByName",
          input: { entryId: p1, name: "Gus" },
          allow: ["owner"],
          expect: { adminMember: "CONFLICT" },
        },
        // The owner is no member (the access list gives them Admin); the
        // Admin member is the last one; the Read member leaves.
        {
          method: "leave",
          input: { entryId: p1 },
          allow: ["readMember"],
          expect: { adminMember: "CONFLICT" },
        },
      ],
    });
    expect(report.cells).toHaveLength(11 * 5);
    expect(report.cells.filter((cell) => cell.principal === "anonymous")).toSatisfy((cells) =>
      (cells as { actual: string }[]).every((cell) => cell.actual === "UNAUTHENTICATED"),
    );
    // What the allowed changes left: gus invited by name, cy gone.
    const roles = await kit.harness().prisma.projectMember.findMany({
      where: { projectId: p1 },
      select: { userId: true, role: true },
    });
    expect(Object.fromEntries(roles.map((row) => [row.userId, row.role]))).toEqual({
      [board.bo]: "Moderate",
      [board.fay]: "Admin",
      [gus]: "Read",
    });
  });

  it("lets a service-wide Admin grant through every default form, and no lower grant", async () => {
    const { app } = await kit.start();
    const board = kit.board();
    const admin = app.as(as(board.gus, { projectService: "Admin" })).projectService;
    expect(await admin.listMembers({ entryId: board.p1 })).toMatchObject({
      items: expect.any(Array),
    });
    expect(await admin.share({ id: board.p1, userId: board.ed, level: "Read" })).toContainEqual({
      userId: board.ed,
      level: "Read",
    });
    const moderate = app.as(as(board.gus, { projectService: "Moderate" })).projectService;
    await expect(
      moderate.share({ id: board.p1, userId: board.gus, level: "Admin" }),
    ).rejects.toMatchObject({ code: "FORBIDDEN" });
    await expect(moderate.listShares({ id: board.p1 })).rejects.toMatchObject({
      code: "FORBIDDEN",
    });
  });
});

describe("forms an app gives", () => {
  const strict = defineContract("strictService", {
    entity: projectEntity,
    methods: {
      ...sharing.contract({ mode: "acl", methods: ["share", "listShares"] }),
      ...sharing.contract({ mode: "members", methods: ["leave", "listMembers"] }),
    },
  });
  const strictService = qd.defineService(strict, {
    model: "project",
    access: anyOf(jsonAcl("acl", { owner: "ownerId" }), projectMembers),
    methods: {
      ...sharing.handlers(strict, {
        access: {
          share: { entry: "Moderate" },
          listShares: { entry: "Admin" },
          listMembers: { service: "Read" },
        },
      }),
    },
  });

  it("replace the defaults of the methods they name, and only those", async () => {
    const app = await createTestApp({ services: [strictService], db: kit.harness().db });
    kit.track(app as unknown as TestApp);
    const board = kit.board();
    await describeAccessMatrix(app, {
      service: strictService,
      principals: { ...principals(), moderateMember: as(board.bo) },
      cases: [
        { method: "listShares", input: { id: board.p1 }, allow: ["owner", "adminMember"] },
        {
          method: "share",
          input: { id: board.p1, userId: board.gus, level: "Read" },
          allow: ["owner", "adminMember", "moderateMember"],
        },
        // A service grant only: no member has one.
        { method: "listMembers", input: { entryId: board.p1 }, allow: [] },
        // leave keeps its default, "authenticated"; only members leave.
        {
          method: "leave",
          input: { entryId: board.p1 },
          allow: ["readMember", "moderateMember"],
          expect: { adminMember: "CONFLICT" },
        },
      ],
    });
    const reader = app.as(as(board.gus, { strictService: "Read" })).strictService;
    expect((await reader.listMembers({ entryId: board.p1 })).items).toHaveLength(1);
  });
});
