// The access tests' board, on the PGlite test schema: five users, two
// projects with an owner, a JSON access list and members, and a task in
// each. Services are typed against the generated Prisma client, so their
// policies' column names are checked against the real models.
//
//            owner   access list    members
//   P1       ada     di: Read       bo: Moderate, cy: Read
//   P2       ed      -              -
//   T1 in P1, T2 in P2

import { randomUUID } from "node:crypto";
import { z } from "zod";
import type { PrismaClient } from "../../../../test/prisma/setup";
import { defineContract, listOf, mutation, query } from "../../../index";
import { QuickdrawError } from "../../../protocol/errors";
import { anyOf, inherit, initQuickdraw, jsonAcl, members, type Principal } from "../../index";

export const qd = initQuickdraw<{ db: PrismaClient; principal: Principal }>();

const projectRow = z.object({ id: z.string(), name: z.string() });
const taskRow = z.object({ id: z.string(), projectId: z.string(), title: z.string() });

export const projectContract = defineContract("projectService", {
  entity: projectRow,
  methods: {
    get: query({ input: z.object({ id: z.string() }), output: "entity" }),
  },
});

export const taskContract = defineContract("taskService", {
  entity: taskRow,
  methods: {
    get: query({ input: z.object({ id: z.string() }), output: "entity" }),
    getMany: query({ input: z.object({ ids: z.array(z.string()) }), output: listOf("entity") }),
    moderate: mutation({
      input: z.object({ id: z.string(), title: z.string() }),
      output: "entity",
    }),
    rename: mutation({ input: z.object({ id: z.string(), title: z.string() }), output: "entity" }),
    create: mutation({
      input: z.object({ projectId: z.string(), title: z.string() }),
      output: "entity",
    }),
    ping: query({ input: z.undefined(), output: z.literal("pong") }),
    whoami: query({ input: z.undefined(), output: z.string() }),
  },
});

/** The membership table, as `members` reads it. */
export const projectMembers = members({
  model: "projectMember",
  entry: "projectId",
  user: "userId",
  level: "role",
});

export const projectService = qd.defineService(projectContract, {
  model: "project",
  access: anyOf(jsonAcl("acl", { owner: "ownerId" }), projectMembers),
  methods: {
    get: {
      access: { entry: "Read" },
      handler: async ({ input, db }) => {
        const found = await db.project.findUnique({ where: { id: input.id } });
        if (found === null) {
          throw new QuickdrawError("NOT_FOUND", "No such project");
        }
        return found;
      },
    },
  },
});

/** A task by id, or `NOT_FOUND`. */
export async function findTask(db: PrismaClient, id: string) {
  const found = await db.task.findUnique({ where: { id } });
  if (found === null) {
    throw new QuickdrawError("NOT_FOUND", "No such task");
  }
  return found;
}

/** The board's task service; `adminBypass: false` for the strict variant. */
export function defineTaskService(options: { readonly adminBypass?: boolean } = {}) {
  return qd.defineService(taskContract, {
    model: "task",
    access: inherit({ from: projectContract, via: "projectId" }),
    adminBypass: options.adminBypass ?? true,
    methods: {
      get: { access: { entry: "Read" }, handler: ({ input, db }) => findTask(db, input.id) },
      getMany: {
        access: { entry: "Read", id: "ids" },
        handler: ({ input, db }) =>
          db.task.findMany({ where: { id: { in: input.ids } }, orderBy: { id: "asc" } }),
      },
      moderate: {
        access: { service: "Moderate", entry: "Read" },
        handler: ({ input, db }) => findTask(db, input.id),
      },
      rename: {
        access: { entry: "Moderate" },
        handler: ({ input, db }) =>
          db.task.update({ where: { id: input.id }, data: { title: input.title } }),
      },
      create: {
        access: { scope: "Moderate", of: projectContract, id: "projectId" },
        handler: ({ input, db }) => db.task.create({ data: input }),
      },
      ping: { access: "public", handler: () => "pong" as const },
      whoami: { access: "authenticated", handler: ({ ctx }) => ctx.principal.userId },
    },
  });
}

export const taskService = defineTaskService();

/** The seeded board's ids. */
export interface Board {
  readonly ada: string;
  readonly bo: string;
  readonly cy: string;
  readonly di: string;
  readonly ed: string;
  readonly p1: string;
  readonly p2: string;
  readonly t1: string;
  readonly t2: string;
}

/** Writes the board with the untracked client. */
export async function seedBoard(prisma: PrismaClient): Promise<Board> {
  const ids: string[] = [];
  for (const name of ["Ada", "Bo", "Cy", "Di", "Ed"]) {
    const user = await prisma.user.create({ data: { email: `${randomUUID()}@example.com`, name } });
    ids.push(user.id);
  }
  const [ada = "", bo = "", cy = "", di = "", ed = ""] = ids;
  const p1 = await prisma.project.create({
    data: { name: "P1", ownerId: ada, acl: [{ userId: di, level: "Read" }] },
  });
  const p2 = await prisma.project.create({ data: { name: "P2", ownerId: ed } });
  await prisma.projectMember.createMany({
    data: [
      { projectId: p1.id, userId: bo, role: "Moderate" },
      { projectId: p1.id, userId: cy, role: "Read" },
    ],
  });
  const t1 = await prisma.task.create({ data: { projectId: p1.id, title: "T1" } });
  const t2 = await prisma.task.create({ data: { projectId: p2.id, title: "T2" } });
  return { ada, bo, cy, di, ed, p1: p1.id, p2: p2.id, t1: t1.id, t2: t2.id };
}

/** A principal acting as `userId`, with service grants when given. */
export function as(userId: string, serviceAccess?: Principal["serviceAccess"]): Principal {
  return serviceAccess === undefined ? { userId } : { userId, serviceAccess };
}
