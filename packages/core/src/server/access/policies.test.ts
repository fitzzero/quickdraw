// The access policies against PGlite (RFC 0003 section 4.2), through
// `dispatcher.access`: each policy's level for the owner, a member, a shared
// user and a stranger; malformed and unknown values; rows that do not exist;
// `accessWhere` matching exactly the rows `levelsFor` lets through; and the
// statements a batch of ids costs.

import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { ACCESS_LEVELS } from "../../contract/access";
import { defineContract, type AccessLevel } from "../../index";
import { createHarness, type Harness } from "../../prisma/__tests__/harness";
import {
  anyOf,
  everyone,
  inherit,
  jsonAcl,
  meetsLevel,
  members,
  owner,
  resolver,
  type Dispatcher,
  type Principal,
} from "../index";
import { as, projectMembers, projectService, qd, seedBoard, type Board } from "./__tests__/board";

const plain = (name: string) => defineContract(name, { methods: {} });

const ownerProjects = qd.defineService(plain("ownerProjects"), {
  model: "project",
  access: owner("ownerId"),
  methods: {},
});
const aclProjects = qd.defineService(plain("aclProjects"), {
  model: "project",
  access: jsonAcl("acl", { owner: "ownerId" }),
  methods: {},
});
const listedProjects = qd.defineService(plain("listedProjects"), {
  model: "project",
  access: jsonAcl("acl"),
  methods: {},
});
const memberProjects = qd.defineService(plain("memberProjects"), {
  model: "project",
  access: projectMembers,
  methods: {},
});
const rolesProjects = qd.defineService(plain("rolesProjects"), {
  model: "project",
  access: members({
    model: "projectMember",
    entry: "projectId",
    user: "userId",
    level: "role",
    levels: { editor: "Moderate", viewer: "Read" },
  }),
  methods: {},
});
const eitherProjects = qd.defineService(plain("eitherProjects"), {
  model: "project",
  access: anyOf(owner("ownerId"), jsonAcl("acl")),
  methods: {},
});
const inheritedTasks = qd.defineService(plain("inheritedTasks"), {
  model: "task",
  access: inherit({ from: aclProjects.contract, via: "projectId" }),
  methods: {},
});
const resolved = qd.defineService(plain("resolved"), {
  model: "project",
  access: resolver({
    levelsFor: (principal, ids) =>
      new Map(ids.map((id) => [id, principal.userId === "root" ? "Admin" : "Owner"])),
    where: (principal) => (principal.userId === "root" ? {} : "none"),
  }),
  methods: {},
});
const listless = qd.defineService(plain("listless"), {
  model: "project",
  access: resolver({
    levelsFor: (_principal, ids) => Object.fromEntries(ids.map((id) => [id, "Read"])),
  }),
  methods: {},
});

const publicProjects = qd.defineService(plain("publicProjects"), {
  model: "project",
  access: anyOf(owner("ownerId"), everyone("Read")),
  methods: {},
});

const services = [
  projectService,
  ownerProjects,
  aclProjects,
  listedProjects,
  memberProjects,
  rolesProjects,
  eitherProjects,
  inheritedTasks,
  resolved,
  listless,
  publicProjects,
] as const;

let h: Harness;
let board: Board;
let dispatcher: Dispatcher<typeof services>;

beforeAll(async () => {
  h = await createHarness();
  dispatcher = qd.createDispatcher({ services, db: h.db });
}, 60_000);

afterAll(async () => {
  await h.close();
});

beforeEach(async () => {
  await h.database.reset();
  board = await seedBoard(h.prisma);
});

/** Each user's level on each of `ids`: `{ ada: [P1's, P2's], ... }`. */
async function levels(service: string, ids: readonly string[]) {
  const table: Record<string, (AccessLevel | null)[]> = {};
  for (const [name, userId] of Object.entries(users())) {
    const found = await dispatcher.access.levelsFor(service, as(userId), ids);
    table[name] = ids.map((id) => found.get(id) ?? null);
  }
  return table;
}

function users() {
  return { ada: board.ada, bo: board.bo, cy: board.cy, di: board.di, ed: board.ed };
}

describe("everyone(level)", () => {
  it("gives every signed-in user the level on every row, and the owner more through anyOf", async () => {
    expect(await levels("publicProjects", [board.p1, board.p2, "missing"])).toEqual({
      ada: ["Admin", "Read", "Read"],
      bo: ["Read", "Read", "Read"],
      cy: ["Read", "Read", "Read"],
      di: ["Read", "Read", "Read"],
      ed: ["Read", "Admin", "Read"],
    });
  });

  it("filters lists to every row at its level, and to the other policies' rows above it", async () => {
    const all = [board.p1, board.p2].sort();
    expect(await visible("publicProjects", "project", as(board.cy), "Read")).toEqual(all);
    expect(await visible("publicProjects", "project", as(board.cy), "Moderate")).toEqual([]);
    expect(await visible("publicProjects", "project", as(board.ada), "Admin")).toEqual([board.p1]);
  });

  it("takes a level that grants something", () => {
    expect(() => everyone("Public")).toThrow(
      'everyone(level): level is "Read", "Moderate" or "Admin"',
    );
    expect(() => everyone("Owner" as AccessLevel)).toThrow("everyone(level)");
  });
});

describe("each policy's levels", () => {
  it("owner: Admin for the user named in the column, nothing for anyone else", async () => {
    expect(await levels("ownerProjects", [board.p1, board.p2, "missing"])).toEqual({
      ada: ["Admin", null, null],
      bo: [null, null, null],
      cy: [null, null, null],
      di: [null, null, null],
      ed: [null, "Admin", null],
    });
  });

  it("jsonAcl: the listed level, plus Admin for the owner column", async () => {
    expect(await levels("aclProjects", [board.p1, board.p2, "missing"])).toEqual({
      ada: ["Admin", null, null],
      bo: [null, null, null],
      cy: [null, null, null],
      di: ["Read", null, null],
      ed: [null, "Admin", null],
    });
    expect(await levels("listedProjects", [board.p1, board.p2])).toEqual({
      ada: [null, null],
      bo: [null, null],
      cy: [null, null],
      di: ["Read", null],
      ed: [null, null],
    });
  });

  it("jsonAcl: a malformed list or entry grants nothing, and the highest entry wins", async () => {
    const { di } = board;
    const grantsTo = async (acl: unknown): Promise<AccessLevel | null> => {
      await h.prisma.project.update({ where: { id: board.p2 }, data: { acl: acl as never } });
      return (
        (await dispatcher.access.levelsFor("listedProjects", as(di), [board.p2])).get(board.p2) ??
        null
      );
    };
    expect(await grantsTo({ userId: di, level: "Admin" })).toBeNull();
    expect(await grantsTo(JSON.stringify([{ userId: di, level: "Admin" }]))).toBeNull();
    expect(await grantsTo([{ userId: di, level: "Owner" }])).toBeNull();
    expect(await grantsTo([{ userId: di }])).toBeNull();
    expect(await grantsTo([{ user: di, level: "Admin" }])).toBeNull();
    expect(await grantsTo([[{ userId: di, level: "Admin" }]])).toBeNull();
    expect(await grantsTo([null, 3, "x", { userId: di, level: "Read" }])).toBe("Read");
    // Several entries for one user: the highest, in any order. 4.x's checkEntryACL took the
    // first (`acl.find`), so it granted Read for both lists (MIGRATION.md, "The access mapping").
    expect(
      await grantsTo([
        { userId: di, level: "Read" },
        { userId: di, level: "Moderate" },
      ]),
    ).toBe("Moderate");
    expect(
      await grantsTo([
        { userId: di, level: "Read" },
        { userId: di, level: "Admin" },
        { userId: board.ada, level: "Read" },
      ]),
    ).toBe("Admin");
  });

  it("members: the member's role, mapped through levels when given", async () => {
    expect(await levels("memberProjects", [board.p1, board.p2])).toEqual({
      ada: [null, null],
      bo: ["Moderate", null],
      cy: ["Read", null],
      di: [null, null],
      ed: [null, null],
    });
    await h.prisma.projectMember.createMany({
      data: [
        { projectId: board.p2, userId: board.di, role: "editor" },
        { projectId: board.p2, userId: board.ada, role: "viewer" },
        { projectId: board.p2, userId: board.cy, role: "Owner" },
      ],
    });
    expect(await levels("rolesProjects", [board.p1, board.p2])).toEqual({
      ada: [null, "Read"],
      bo: [null, null],
      cy: [null, null],
      di: [null, "Moderate"],
      ed: [null, null],
    });
    expect((await levels("memberProjects", [board.p2])).cy).toEqual([null]);
  });

  it("anyOf: the highest level any of its policies grants", async () => {
    expect(await levels("projectService", [board.p1, board.p2])).toEqual({
      ada: ["Admin", null],
      bo: ["Moderate", null],
      cy: ["Read", null],
      di: ["Read", null],
      ed: [null, "Admin"],
    });
    await h.prisma.projectMember.create({
      data: { projectId: board.p1, userId: board.di, role: "Moderate" },
    });
    expect((await levels("projectService", [board.p1])).di).toEqual(["Moderate"]);
  });

  it("inherit: the level on the parent row; a row that does not exist has none", async () => {
    expect(await levels("inheritedTasks", [board.t1, board.t2, "missing", board.p1])).toEqual({
      ada: ["Admin", null, null, null],
      bo: [null, null, null, null],
      cy: [null, null, null, null],
      di: ["Read", null, null, null],
      ed: [null, "Admin", null, null],
    });
  });

  it("resolver: the levels app code returns, unknown ones counting as none", async () => {
    const root = await dispatcher.access.levelsFor("resolved", as("root"), [board.p1, "x"]);
    expect([...root]).toEqual([
      [board.p1, "Admin"],
      ["x", "Admin"],
    ]);
    expect(
      (await dispatcher.access.levelsFor("resolved", as(board.ada), [board.p1])).get(board.p1),
    ).toBeNull();
    expect((await dispatcher.access.levelsFor("listless", as(board.ada), ["a"])).get("a")).toBe(
      "Read",
    );
  });
});

/** The rows of `model` the filter for `level` matches. */
async function visible(service: string, model: string, principal: Principal, level: AccessLevel) {
  const where = await dispatcher.access.accessWhere(service, principal, level);
  if (where === "none") {
    return [];
  }
  const rows = await h.storage.findMany(model, { where, select: { id: true } });
  return rows.map((row) => String(row.id)).sort();
}

/** The rows of `model` on which `levelsFor` gives at least `level`. */
async function allowed(service: string, model: string, principal: Principal, level: AccessLevel) {
  const all = (await h.storage.findMany(model, { select: { id: true } })).map((row) =>
    String(row.id),
  );
  const found = await dispatcher.access.levelsFor(service, principal, all);
  return all.filter((id) => meetsLevel(found.get(id), level)).sort();
}

describe("accessWhere", () => {
  const cases = [
    ["ownerProjects", "project"],
    ["aclProjects", "project"],
    ["listedProjects", "project"],
    ["memberProjects", "project"],
    ["rolesProjects", "project"],
    ["eitherProjects", "project"],
    ["projectService", "project"],
    ["inheritedTasks", "task"],
    ["publicProjects", "project"],
  ] as const;

  it("matches exactly the rows levelsFor lets through, for every policy, user and level", async () => {
    await h.prisma.projectMember.createMany({
      data: [
        { projectId: board.p2, userId: board.di, role: "editor" },
        { projectId: board.p2, userId: board.bo, role: "Admin" },
      ],
    });
    await h.prisma.project.create({
      data: {
        name: "P3",
        ownerId: board.bo,
        acl: [{ userId: board.cy, level: "Moderate" }, "junk"],
      },
    });
    await h.prisma.task.create({ data: { projectId: board.p2, title: "T3" } });
    let nonEmpty = 0;
    for (const [service, model] of cases) {
      for (const userId of Object.values(users())) {
        for (const level of ACCESS_LEVELS) {
          const expected = await allowed(service, model, as(userId), level);
          expect(await visible(service, model, as(userId), level), `${service} ${level}`).toEqual(
            expected,
          );
          nonEmpty += expected.length > 0 ? 1 : 0;
        }
      }
    }
    expect(nonEmpty).toBeGreaterThan(40);
  });

  it("is a column filter, a JSON containment, or the ids of a membership read", async () => {
    const di = as(board.di);
    expect(await dispatcher.access.accessWhere("ownerProjects", di, "Read")).toEqual({
      ownerId: board.di,
    });
    expect(await dispatcher.access.accessWhere("listedProjects", di, "Moderate")).toEqual({
      OR: [
        { acl: { array_contains: [{ userId: board.di, level: "Moderate" }] } },
        { acl: { array_contains: [{ userId: board.di, level: "Admin" }] } },
      ],
    });
    expect(await dispatcher.access.accessWhere("memberProjects", as(board.bo), "Read")).toEqual({
      id: { in: [board.p1] },
    });
    expect(await dispatcher.access.accessWhere("memberProjects", di, "Read")).toBe("none");
    expect(await dispatcher.access.accessWhere("inheritedTasks", di, "Read")).toEqual({
      projectId: { in: [board.p1] },
    });
    expect(await dispatcher.access.accessWhere("resolved", as("root"), "Admin")).toEqual({});
    expect(await dispatcher.access.accessWhere("resolved", di, "Read")).toBe("none");
    expect(await dispatcher.access.accessWhere("listless", di, "Read")).toBe("none");
  });

  it("lets a service Admin with adminBypass see every row", async () => {
    const admin = as(board.ed, { projectService: "Admin" });
    expect(await dispatcher.access.accessWhere("projectService", admin, "Admin")).toEqual({});
    expect([
      ...(await dispatcher.access.levelsFor(projectService.contract, admin, ["any"])),
    ]).toEqual([["any", "Admin"]]);
    // A grant below Admin counts only where a form names service: ed sees only P2, which he owns.
    const reader = as(board.ed, { projectService: "Moderate" });
    expect(await visible("projectService", "project", reader, "Read")).toEqual([board.p2]);
    const strict = await dispatcher.access.levelsFor("projectService", reader, [
      board.p1,
      board.p2,
    ]);
    expect([...strict.values()]).toEqual([null, "Admin"]);
  });
});

describe("batching", () => {
  async function sixtyTasks(): Promise<string[]> {
    const p3 = await h.prisma.project.create({ data: { name: "P3", ownerId: board.cy } });
    const projects = [board.p1, board.p2, p3.id];
    await h.prisma.task.createMany({
      data: Array.from({ length: 58 }, (_, index) => ({
        projectId: projects[index % 3] ?? board.p1,
        title: `t${index}`,
      })),
    });
    return (await h.prisma.task.findMany({ select: { id: true } })).map((row) => row.id);
  }

  async function statements(service: string, userId: string, ids: readonly string[]) {
    const counted = await h.storage.countStatements(() =>
      dispatcher.access.levelsFor(service, as(userId), ids),
    );
    return counted.statements;
  }

  it("resolves 60 ids in at most two statements", async () => {
    const tasks = await sixtyTasks();
    expect(tasks).toHaveLength(60);
    // The tasks' projectId, then the parents' access list and owner.
    expect(await statements("inheritedTasks", board.ada, tasks)).toBe(2);
    const projects = (await h.prisma.project.findMany({ select: { id: true } })).map(
      (row) => row.id,
    );
    const sixty = Array.from({ length: 60 }, (_, index) => projects[index % 3] ?? board.p1);
    expect(await statements("memberProjects", board.bo, sixty)).toBe(1);
    expect(await statements("aclProjects", board.di, sixty)).toBe(1);
    // Two policies on the project's own columns share one read of them.
    expect(await statements("eitherProjects", board.di, sixty)).toBe(1);
    const found = await dispatcher.access.levelsFor("inheritedTasks", as(board.ada), tasks);
    expect([...found.values()].filter((level) => level === "Admin")).toHaveLength(21);
  });

  it("reads each row once per call, however often a call asks", async () => {
    expect(
      await statements("aclProjects", board.di, [board.p1, board.p1, board.p2, board.p1]),
    ).toBe(1);
    expect(await statements("inheritedTasks", board.di, [board.t1, board.t1])).toBe(2);
    expect(await statements("inheritedTasks", board.di, [])).toBe(0);
  });
});

describe("dispatcher.access", () => {
  it("refuses a service without a policy, a principal without a user id, and bad ids or levels", async () => {
    await expect(dispatcher.access.levelsFor("nope", as("u"), ["a"])).rejects.toThrow(
      "nope is not a service of this dispatcher with an access policy",
    );
    await expect(
      dispatcher.access.levelsFor("projectService", { userId: "" }, ["a"]),
    ).rejects.toThrow("principal must be a principal with a userId");
    await expect(
      dispatcher.access.levelsFor("projectService", as("u"), ["a", 3 as unknown as string]),
    ).rejects.toThrow("ids must be an array of row ids");
    await expect(
      dispatcher.access.accessWhere("projectService", as("u"), "Owner" as AccessLevel),
    ).rejects.toThrow("level must be an access level");
  });
});
