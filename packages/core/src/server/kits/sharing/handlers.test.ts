// `sharing.handlers` itself (RFC 0003 section 12.3): the services it refuses
// when they are defined (no model, no `jsonAcl` or `members` policy for a
// mode the contract uses, more than one, another contract's handlers), the
// options it refuses, the `onChange` hook inside the change's transaction,
// and the SERIALIZABLE transaction whose write conflicts are `CONFLICT`.

import { describe, expect, it, vi } from "vitest";
import type { PrismaClient } from "../../../../test/prisma/setup";
import { consoleLogger, crud, defineContract } from "../../../index";
import { createTestApp, type TestApp } from "../../../testing/index";
import { qd } from "../../access/__tests__/board";
import { createContext } from "../../context";
import {
  anyOf,
  inherit,
  jsonAcl,
  owner as ownerColumn,
  sharing,
  type SharingChange,
} from "../../index";
import {
  as,
  defineProjectService,
  projectContract,
  projectEntity,
  projectMembers,
  sharingApp,
  subscribeProjects,
} from "./__tests__/fixture";

const kit = sharingApp();

const acl = defineContract("aclService", {
  entity: projectEntity,
  methods: { ...sharing.contract({ mode: "acl" }) },
});

const team = defineContract("teamService", {
  entity: projectEntity,
  methods: { ...sharing.contract({ mode: "members", methods: ["invite", "leave"] }) },
});

/** `defineService`, untyped: the definitions below are wrong on purpose. */
const define = (contract: unknown, definition: unknown) =>
  qd.defineService(contract as never, definition as never);

describe("the services sharing.handlers refuses", () => {
  it("needs the service's policy to have the mode's list or table, alone or inside anyOf", () => {
    expect(() =>
      define(acl, {
        model: "project",
        access: ownerColumn("ownerId"),
        methods: sharing.handlers(acl),
      }),
    ).toThrow(
      'defineService("aclService"): method "share": the sharing kit\'s "acl" methods need a jsonAcl(field) policy, whose access list they change, alone or inside anyOf; aclService declares owner(...)',
    );
    expect(() =>
      define(team, { model: "project", access: jsonAcl("acl"), methods: sharing.handlers(team) }),
    ).toThrow(/"members" methods need a members\(\{ model, entry, user, level \}\) policy/);
    const nested = anyOf(ownerColumn("ownerId"), anyOf(projectMembers, jsonAcl("acl")));
    expect(() =>
      define(acl, { model: "project", access: nested, methods: sharing.handlers(acl) }),
    ).not.toThrow();
    expect(() =>
      define(team, { model: "project", access: nested, methods: sharing.handlers(team) }),
    ).not.toThrow();
  });

  it("refuses an access-list method under a form that checks no row, unless rowless names it", () => {
    const definition = (options: object) => ({
      model: "project",
      access: jsonAcl("acl"),
      methods: sharing.handlers(acl, options as never),
    });
    expect(() => define(acl, definition({}))).not.toThrow();
    expect(() => define(acl, definition({ access: { listShares: "authenticated" } }))).toThrow(
      'defineService("aclService"): method "listShares" takes a row id (its input has id), but its access "authenticated" checks no row',
    );
    expect(() => define(acl, definition({ access: { unshare: { service: "Read" } } }))).toThrow(
      'name it in the kit\'s rowless option (rowless: ["unshare"])',
    );
    expect(() =>
      define(acl, definition({ access: { listShares: "authenticated" }, rowless: ["listShares"] })),
    ).not.toThrow();
    // members mode names its row entryId, so its "authenticated" leave is not one of them
    expect(() =>
      define(team, {
        model: "project",
        access: projectMembers,
        methods: sharing.handlers(team),
      }),
    ).not.toThrow();
  });

  it("needs one list or table to change, not two", () => {
    const twoLists = anyOf(jsonAcl("acl"), jsonAcl("name"));
    expect(() =>
      define(acl, { model: "project", access: twoLists, methods: sharing.handlers(acl) }),
    ).toThrow(/need one jsonAcl policy to change, and aclService's has 2/);
    // One policy named twice is one table.
    const twice = anyOf(projectMembers, projectMembers);
    expect(() =>
      define(team, { model: "project", access: twice, methods: sharing.handlers(team) }),
    ).not.toThrow();
  });

  it("needs a model and the service's own contract", () => {
    const open = { invite: "authenticated", leave: "authenticated" } as const;
    expect(() => define(team, { methods: sharing.handlers(team, { access: open }) })).toThrow(
      /the sharing kit changes who may see the service's rows: declare its model/,
    );
    expect(() =>
      define(acl, {
        model: "project",
        access: jsonAcl("acl"),
        methods: sharing.handlers(projectContract, { resolveUser: () => null }),
      }),
    ).toThrow();
    const twin = defineContract("aclService", {
      entity: projectEntity,
      methods: { ...sharing.contract({ mode: "acl" }) },
    });
    expect(() =>
      define(acl, { model: "project", access: jsonAcl("acl"), methods: sharing.handlers(twin) }),
    ).toThrow(/made for another contract; pass aclService's own contract to sharing.handlers/);
  });

  it("is refused by the access rules first when a default form needs a policy", () => {
    expect(() => define(acl, { model: "project", methods: sharing.handlers(acl) })).toThrow(
      /uses entry access, which needs the service's access policy/,
    );
    expect(() =>
      define(acl, {
        model: "project",
        access: inherit({ from: projectContract, via: "id" }),
        methods: sharing.handlers(acl),
      }),
    ).toThrow(/aclService declares inherit\(\.\.\.\)/);
  });
});

describe("the options sharing.handlers refuses", () => {
  it("refuses a contract without the kit's methods, and unknown or malformed options", () => {
    const plain = defineContract("plainService", {
      entity: projectEntity,
      methods: { ...crud.contract({ entity: projectEntity, get: true }) },
    });
    const handlers = sharing.handlers as unknown as (
      contract: unknown,
      options?: unknown,
    ) => object;
    expect(() => handlers(plain)).toThrow(
      "sharing.handlers: plainService has no method sharing.contract made",
    );
    expect(() => handlers({ name: "x", methods: {} })).toThrow(/a contract from defineContract/);
    expect(() => handlers(acl, { prepare: () => ({}) })).toThrow(/unknown key "prepare"/);
    expect(() => handlers(acl, { access: { invite: "public" } })).toThrow(
      /access names "invite", which is not a method sharing.contract made/,
    );
    expect(() => handlers(acl, { access: { share: { entry: "Owner" } } })).toThrow(
      /access for "share" needs service, entry or scope set to an access level/,
    );
    expect(() => handlers(acl, { onChange: "log" })).toThrow(/onChange must be a function/);
  });

  it("needs resolveUser for the by-name methods, and only for them", () => {
    const byName = defineContract("byNameService", {
      entity: projectEntity,
      methods: { ...sharing.contract({ mode: "acl", methods: ["shareByName"] }) },
    });
    const handlers = sharing.handlers as unknown as (
      contract: unknown,
      options?: unknown,
    ) => object;
    expect(() => handlers(byName)).toThrow(/find their user with resolveUser: give it/);
    expect(() => handlers(byName, { resolveUser: () => null })).not.toThrow();
    expect(() => handlers(acl, { resolveUser: () => null })).toThrow(
      /resolveUser is for shareByName and inviteByName, which the contract does not have/,
    );
  });

  it("returns the kit's default forms, and the ones access gives", () => {
    const made = sharing.handlers(projectContract, {
      resolveUser: () => null,
      access: { listMembers: { service: "Read" } },
    });
    expect(Object.keys(made).sort()).toEqual(
      [
        "share",
        "unshare",
        "setLevel",
        "listShares",
        "shareByName",
        "invite",
        "remove",
        "leave",
        "setRole",
        "listMembers",
        "inviteByName",
      ].sort(),
    );
    expect(made.share.access).toEqual({ entry: "Admin" });
    expect(made.listShares.access).toEqual({ entry: "Read" });
    expect(made.invite.access).toEqual({ entry: "Admin", id: "entryId" });
    expect(made.leave.access).toBe("authenticated");
    expect(made.listMembers.access).toEqual({ service: "Read" });
    expect(Object.isFrozen(made)).toBe(true);
  });
});

describe("onChange", () => {
  it("runs after each change, inside its transaction, and not when nothing changed", async () => {
    const seen: { change: SharingChange; caller: string; inside: unknown }[] = [];
    const { app } = await kit.start({
      onChange: async (change, ctx, db) => {
        // The transaction's own client: it sees the change before it commits.
        const tx = db as PrismaClient;
        const inside = ["share", "setLevel", "unshare"].includes(change.kind)
          ? (await tx.project.findUniqueOrThrow({ where: { id: change.id } })).acl
          : await tx.projectMember.count({
              where: { projectId: change.id, userId: change.userId },
            });
        seen.push({ change, caller: ctx.principal.userId, inside });
      },
    });
    const board = kit.board();
    const owner = app.as(as(board.ada)).projectService;
    await owner.share({ id: board.p1, userId: board.gus, level: "Read" });
    await owner.share({ id: board.p1, userId: board.gus, level: "Read" });
    await owner.setLevel({ id: board.p1, userId: board.gus, level: "Admin" });
    await owner.unshare({ id: board.p1, userId: board.gus });
    await owner.invite({ entryId: board.p1, userId: board.gus, role: "Moderate" });
    await owner.setRole({ entryId: board.p1, userId: board.gus, role: "Moderate" });
    await owner.setRole({ entryId: board.p1, userId: board.gus, role: "Read" });
    await owner.remove({ entryId: board.p1, userId: board.gus });
    const { p1, gus, di, ada } = board;
    const reader = { userId: di, level: "Read" };
    expect(seen).toEqual(
      [
        {
          change: { kind: "share", id: p1, userId: gus, before: null, after: "Read" },
          inside: [reader, { userId: gus, level: "Read" }],
        },
        {
          change: { kind: "setLevel", id: p1, userId: gus, before: "Read", after: "Admin" },
          inside: [reader, { userId: gus, level: "Admin" }],
        },
        {
          change: { kind: "unshare", id: p1, userId: gus, before: "Admin", after: null },
          inside: [reader],
        },
        {
          change: { kind: "invite", id: p1, userId: gus, before: null, after: "Moderate" },
          inside: 1,
        },
        {
          change: { kind: "setRole", id: p1, userId: gus, before: "Moderate", after: "Read" },
          inside: 1,
        },
        {
          change: { kind: "remove", id: p1, userId: gus, before: "Read", after: null },
          inside: 0,
        },
      ].map((entry) => ({ ...entry, caller: ada })),
    );
  });

  it("undoes the change when it throws, and nobody's access changes", async () => {
    const { app } = await kit.start({
      onChange: (change) => {
        if (change.kind === "unshare" || change.kind === "leave") {
          throw new Error("audit log unavailable");
        }
      },
    });
    const board = kit.board();
    const connection = await app.connect(as(board.di));
    expect(await subscribeProjects(connection, [board.p1])).toMatchObject({ r: [{ ok: true }] });
    await expect(
      app.as(as(board.ada)).projectService.unshare({ id: board.p1, userId: board.di }),
    ).rejects.toMatchObject({ code: "INTERNAL" });
    await expect(
      app.as(as(board.cy)).projectService.leave({ entryId: board.p1 }),
    ).rejects.toMatchObject({ code: "INTERNAL" });
    const { prisma } = kit.harness();
    expect((await prisma.project.findUniqueOrThrow({ where: { id: board.p1 } })).acl).toEqual([
      { userId: board.di, level: "Read" },
    ]);
    expect(
      await prisma.projectMember.count({ where: { projectId: board.p1, userId: board.cy } }),
    ).toBe(1);
    expect(await connection.call.projectService.get({ id: board.p1 })).toMatchObject({
      id: board.p1,
    });
    expect(app.frames({ event: "qd:revoked" })).toEqual([]);
  });
});

describe("the transaction", () => {
  /** The harness's tracked client, its `$transaction` recording its options and failing on demand. */
  function watchedDb(fail: () => Error | undefined) {
    const db = kit.harness().db;
    const options: unknown[] = [];
    const watched = new Proxy(db, {
      get(target, key) {
        if (key !== "$transaction") {
          return Reflect.get(target, key) as unknown;
        }
        return async (fn: unknown, given?: unknown) => {
          options.push(given);
          const error = fail();
          if (error !== undefined) {
            throw error;
          }
          return await target.$transaction(fn as never, given as never);
        };
      },
    });
    return { db: watched, options };
  }

  /** A conflict as Prisma reports a failed statement: P2034. */
  function failedStatement(): Error {
    const error = new Error("Transaction failed due to a write conflict or a deadlock");
    return Object.assign(error, { name: "PrismaClientKnownRequestError", code: "P2034" });
  }

  /**
   * A conflict as PostgreSQL reports it at commit (SSI: two members leaving
   * at once), which Prisma 7 passes through as the driver adapter's error.
   */
  function failedCommit(): Error {
    const error = new Error("TransactionWriteConflict");
    return Object.assign(error, {
      name: "DriverAdapterError",
      cause: { kind: "TransactionWriteConflict", originalCode: "40001" },
    });
  }

  it("is SERIALIZABLE, and a write conflict the database reports is CONFLICT", async () => {
    let fail: (() => Error) | undefined;
    const { db, options } = watchedDb(() => fail?.());
    const app = await createTestApp({ services: [defineProjectService()], db });
    kit.track(app as unknown as TestApp);
    const board = kit.board();
    const owner = app.as(as(board.ada)).projectService;
    await owner.share({ id: board.p1, userId: board.gus, level: "Read" });
    await owner.invite({ entryId: board.p1, userId: board.gus });
    expect(options).toEqual([
      { isolationLevel: "Serializable" },
      { isolationLevel: "Serializable" },
    ]);

    for (const conflict of [failedStatement, failedCommit]) {
      fail = conflict;
      for (const call of [
        owner.unshare({ id: board.p1, userId: board.gus }),
        owner.remove({ entryId: board.p1, userId: board.gus }),
      ]) {
        await expect(call).rejects.toMatchObject({
          code: "CONFLICT",
          message: "Another change to this row's access ran at the same time; try again",
        });
      }
    }
    // Any other failure is not a conflict.
    fail = () => Object.assign(new Error("connection lost"), { name: "DriverAdapterError" });
    await expect(owner.unshare({ id: board.p1, userId: board.gus })).rejects.toMatchObject({
      code: "INTERNAL",
    });
    // The reads need no transaction.
    expect(await owner.listShares({ id: board.p1 })).toHaveLength(2);
    expect(options).toHaveLength(7);
  });

  it("reads the caller's level again inside the transaction, and refuses one lowered meanwhile", async () => {
    const board = kit.board();
    const { prisma } = kit.harness();
    // Another change demotes Fay, P1's Admin member, after the pipeline checked her and
    // before her change's transaction opens.
    let demote = false;
    const db = new Proxy(kit.harness().db, {
      get(target, key) {
        if (key !== "$transaction") {
          return Reflect.get(target, key) as unknown;
        }
        return async (fn: unknown, given?: unknown) => {
          if (demote) {
            await prisma.projectMember.updateMany({
              where: { projectId: board.p1, userId: board.fay },
              data: { role: "Read" },
            });
          }
          return await target.$transaction(fn as never, given as never);
        };
      },
    });
    const app = await createTestApp({ services: [defineProjectService()], db });
    kit.track(app as unknown as TestApp);
    const fay = app.as(as(board.fay)).projectService;
    demote = true;
    await expect(
      fay.share({ id: board.p1, userId: board.gus, level: "Read" }),
    ).rejects.toMatchObject({
      code: "FORBIDDEN",
      message: expect.stringContaining("no longer have Admin"),
    });
    await expect(fay.invite({ entryId: board.p1, userId: board.gus })).rejects.toMatchObject({
      code: "FORBIDDEN",
    });
    expect((await prisma.project.findUniqueOrThrow({ where: { id: board.p1 } })).acl).toEqual([
      { userId: board.di, level: "Read" },
    ]);
    expect(await prisma.projectMember.count({ where: { userId: board.gus } })).toBe(0);
  });

  it("asks for the caller's level from inside the transaction's callback", async () => {
    const service = defineProjectService();
    let inside = false;
    const asked: boolean[] = [];
    const levelsFor = (_service: unknown, _principal: unknown, ids: readonly string[]) => {
      asked.push(inside);
      return Promise.resolve(new Map(ids.map((id) => [id, "Moderate" as const])));
    };
    const update = vi.fn();
    const tx = {
      project: {
        findUnique: () => Promise.resolve({ id: "p", acl: [], ownerId: "owner" }),
        findMany: () => Promise.resolve([]),
        update,
      },
    };
    const db = {
      $transaction: async (fn: (client: unknown) => Promise<unknown>) => {
        inside = true;
        try {
          return await fn(tx);
        } finally {
          inside = false;
        }
      },
    };
    const access = {
      levelsFor,
      accessWhere: vi.fn(),
      onAccessChanged: vi.fn(),
      resolve: vi.fn(),
    };
    const ctx = createContext({
      principal: as("caller"),
      signal: new AbortController().signal,
      log: consoleLogger,
      requestId: "r1",
      transport: "internal",
      kit: { service, access, storage: undefined },
    });
    const share = service.methods.share?.handler as unknown as (args: object) => Promise<unknown>;
    // The default form needs Admin; the caller holds Moderate by the time the change runs.
    await expect(
      share({ input: { id: "p", userId: "someone", level: "Read" }, ctx, db }),
    ).rejects.toMatchObject({ code: "FORBIDDEN" });
    expect(asked).toEqual([true]);
    expect(update).not.toHaveBeenCalled();
  });
});
