// The sharing kit tests' app, on the access tests' board
// (`../../../access/__tests__/board.ts`): a project service made of the
// kit's methods in both modes (its access list and its members table, both
// read by the service's `anyOf` policy), the read/write kit's `get`, and
// `mine`, each user's projects through the membership table (a `via`
// collection whose scope is the subscriber's own user id).
//
//            owner   access list    members
//   P1       ada     di: Read       bo: Moderate, cy: Read, fay: Admin
//   P2       ed      -              -
//   gus has no access to either: a user to share with and invite.

import { randomUUID } from "node:crypto";
import { afterAll, afterEach, beforeAll, beforeEach } from "vitest";
import { z } from "zod";
import type { PrismaClient } from "../../../../../test/prisma/setup";
import {
  crud as crudContract,
  defineContract,
  sharing as sharingContract,
  via,
} from "../../../../index";
import { createHarness, type Harness } from "../../../../prisma/__tests__/harness";
import {
  createTestApp,
  emitWithAck,
  type TestApp,
  type TestConnection,
} from "../../../../testing/index";
import { as, qd, seedBoard, type Board } from "../../../access/__tests__/board";
import { anyOf, crud, jsonAcl, members, sharing, type SharingOnChange } from "../../../index";

export { as };

export const projectEntity = z.object({ id: z.string(), name: z.string(), ownerId: z.string() });

export const projectContract = defineContract("projectService", {
  entity: projectEntity,
  methods: {
    ...crudContract.contract({ entity: projectEntity, get: true }),
    ...sharingContract.contract({
      mode: "acl",
      methods: ["share", "unshare", "setLevel", "listShares", "shareByName"],
    }),
    ...sharingContract.contract({
      mode: "members",
      methods: ["invite", "remove", "leave", "setRole", "listMembers", "inviteByName"],
    }),
  },
  collections: {
    /** The projects a user is a member of. */
    mine: {
      scope: via({ model: "projectMember", entry: "projectId", scope: "userId" }),
      item: "entity",
      order: [["id", "asc"]],
    },
  },
});

/** The membership table, as the project service's `members` policy reads it. */
export const projectMembers = members({
  model: "projectMember",
  entry: "projectId",
  user: "userId",
  level: "role",
});

/** Finds a user by name or email, as an app's `resolveUser` would. */
async function findUser(
  lookup: { readonly name?: string; readonly email?: string },
  db: unknown,
): Promise<string | undefined> {
  const where = lookup.name === undefined ? { email: lookup.email } : { name: lookup.name };
  return (await (db as PrismaClient).user.findFirst({ where, select: { id: true } }))?.id;
}

/** Options of {@link defineProjectService}. */
export interface ProjectServiceOptions {
  readonly onChange?: SharingOnChange;
}

/** The kit's project service: both modes, `get`, and the `mine` collection. */
export function defineProjectService(options: ProjectServiceOptions = {}) {
  return qd.defineService(projectContract, {
    model: "project",
    access: anyOf(jsonAcl("acl", { owner: "ownerId" }), projectMembers),
    collections: { mine: { scopeAccess: "self" } },
    methods: {
      ...crud.handlers(projectContract, { access: { get: { entry: "Read" } } }),
      ...sharing.handlers(projectContract, {
        resolveUser: (lookup, _ctx, db) => findUser(lookup, db),
        ...(options.onChange === undefined ? {} : { onChange: options.onChange }),
      }),
    },
  });
}

/** The seeded board's ids, with fay (P1's Admin member) and gus (no access). */
export interface SharingBoard extends Board {
  readonly fay: string;
  readonly gus: string;
}

async function seed(prisma: PrismaClient): Promise<SharingBoard> {
  const board = await seedBoard(prisma);
  const [fay, gus] = await Promise.all(
    ["Fay", "Gus"].map(async (name) => {
      const user = await prisma.user.create({
        data: { email: `${name.toLowerCase()}-${randomUUID()}@example.com`, name },
      });
      return user.id;
    }),
  );
  await prisma.projectMember.create({
    data: { projectId: board.p1, userId: fay ?? "", role: "Admin" },
  });
  return { ...board, fay: fay ?? "", gus: gus ?? "" };
}

/**
 * The suite's harness: call once per test file. Each file gets a PGlite
 * database, each test a freshly seeded board; apps started with `start` are
 * closed after the test.
 */
export function sharingApp() {
  let harness: Harness | undefined;
  let seeded: SharingBoard | undefined;
  const apps: TestApp[] = [];

  beforeAll(async () => {
    harness = await createHarness();
  }, 60_000);
  afterAll(async () => {
    await harness?.close();
  });
  beforeEach(async () => {
    await harness?.database.reset();
    seeded = harness === undefined ? undefined : await seed(harness.prisma);
  });
  afterEach(async () => {
    await Promise.all(apps.splice(0).map(async (app) => await app.close()));
  });

  const current = (): Harness => {
    if (harness === undefined) {
      throw new Error("the sharing harness has no database yet");
    }
    return harness;
  };

  return {
    harness: current,
    /** The board seeded for this test. */
    board(): SharingBoard {
      if (seeded === undefined) {
        throw new Error("the board is seeded before each test");
      }
      return seeded;
    },
    /** Starts an app serving the kit's project service. */
    async start(options: ProjectServiceOptions = {}) {
      const service = defineProjectService(options);
      const app = await createTestApp({ services: [service], db: current().db });
      apps.push(app as unknown as TestApp);
      return { app, service };
    },
    /** Closes `app` after the test. */
    track(app: TestApp): void {
      apps.push(app);
    },
  };
}

/** Sends `qd:col:sub` for one scope of the project service's `mine` and resolves with the reply. */
export function subscribeMine(
  connection: Pick<TestConnection, "socket">,
  userId: string,
): Promise<Record<string, unknown>> {
  return emitWithAck(connection.socket, "qd:col:sub", {
    s: "projectService",
    c: "mine",
    scope: userId,
  });
}

/** Sends `qd:sub` for project rows and resolves with the reply. */
export function subscribeProjects(
  connection: Pick<TestConnection, "socket">,
  ids: readonly string[],
): Promise<unknown> {
  return emitWithAck(connection.socket, "qd:sub", { s: "projectService", ids });
}
