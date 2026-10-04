// The live-data tests' services and helpers, on the access tests' board
// (`../../access/__tests__/board.ts`): a project service with an owner, a
// JSON access list and members, and task services inheriting from it, whose
// entity has an `Admin`-only `notes` field.
//
//            owner   access list    members              level on T1
//   P1       ada     di: Read       bo: Moderate, cy: Read
//   T1 in P1                                             ada Admin, bo Moderate, cy Read, di Read
//   T2 in P2 (owner ed)                                  ed Admin

import { z } from "zod";
import { settleCluster } from "../../../../test/cluster/mode";
import type { PrismaClient } from "../../../../test/prisma/setup";
import {
  defineContract,
  mutation,
  query,
  type EntityFrame,
  type RevokedFrame,
} from "../../../index";
import { emitWithAck, type TestConnection } from "../../../testing/index";
import {
  anyOf,
  inherit,
  initQuickdraw,
  jsonAcl,
  type Principal,
  type StorageAdapter,
} from "../../index";
import { findTask, projectMembers } from "../../access/__tests__/board";

export const qd = initQuickdraw<{ db: PrismaClient; principal: Principal }>();

const projectRow = z.object({ id: z.string(), name: z.string() });

export const taskEntity = z.object({
  id: z.string(),
  projectId: z.string(),
  parentTaskId: z.string().nullable(),
  title: z.string(),
  status: z.string(),
  notes: z.string().nullable(),
  updatedAt: z.string(),
});

/** The entity's keys, in schema order: what a read of it selects. */
export const TASK_KEYS = Object.keys(taskEntity.shape);

export const projectContract = defineContract("projectService", {
  entity: projectRow,
  methods: {
    rename: mutation({ input: z.object({ id: z.string(), name: z.string() }), output: "entity" }),
    setRole: mutation({
      input: z.object({ projectId: z.string(), userId: z.string(), role: z.string() }),
      output: z.number(),
    }),
    removeMember: mutation({
      input: z.object({ projectId: z.string(), userId: z.string() }),
      output: z.number(),
    }),
    setGrants: mutation({
      input: z.object({ userId: z.string(), grants: z.record(z.string(), z.string()) }),
      output: z.null(),
    }),
  },
});

export const projectService = qd.defineService(projectContract, {
  model: "project",
  access: anyOf(jsonAcl("acl", { owner: "ownerId" }), projectMembers),
  writes: ["projectMember", "user"],
  methods: {
    rename: {
      access: { entry: "Moderate" },
      handler: ({ input, db }) =>
        db.project.update({ where: { id: input.id }, data: { name: input.name } }),
    },
    setRole: {
      access: "authenticated",
      handler: async ({ input, db }) =>
        (
          await db.projectMember.updateMany({
            where: { projectId: input.projectId, userId: input.userId },
            data: { role: input.role },
          })
        ).count,
    },
    removeMember: {
      access: "authenticated",
      handler: async ({ input, db }) =>
        (
          await db.projectMember.deleteMany({
            where: { projectId: input.projectId, userId: input.userId },
          })
        ).count,
    },
    setGrants: {
      access: "authenticated",
      handler: async ({ input, db }) => {
        await db.user.update({
          where: { id: input.userId },
          data: { serviceAccess: input.grants },
        });
        return null;
      },
    },
  },
});

const id = z.object({ id: z.string() });

export const taskContract = defineContract("taskService", {
  entity: taskEntity,
  fields: { notes: "Admin" },
  methods: {
    get: query({ input: id, output: "entity" }),
    getShared: query({ input: id, output: "entity" }),
    rename: mutation({ input: z.object({ id: z.string(), title: z.string() }), output: z.null() }),
    renameTenTimes: mutation({ input: id, output: z.null() }),
    setNotes: mutation({
      input: z.object({ id: z.string(), notes: z.string() }),
      output: z.null(),
    }),
    setStatus: mutation({
      input: z.object({ id: z.string(), status: z.string() }),
      output: z.null(),
    }),
    addChild: mutation({ input: z.object({ parentTaskId: z.string() }), output: z.string() }),
    recreate: mutation({ input: id, output: z.null() }),
    remove: mutation({ input: id, output: z.null() }),
    touch: mutation({ input: id, output: z.null() }),
  },
});

/** Opens `getShared` once the test lets it, so concurrent callers share one run. */
export interface Gate {
  wait: Promise<void>;
  runs: number;
}

/**
 * The task service; `versionColumn: "updatedAt"` for the variant that
 * answers "not modified" from it. Its writes are `rowless`: they let any
 * signed-in test principal change any task, so the tests can watch what each
 * subscriber receives whoever wrote.
 */
export function defineTaskService(
  options: { readonly versionColumn?: "updatedAt"; readonly gate?: Gate } = {},
) {
  const gate = options.gate ?? { wait: Promise.resolve(), runs: 0 };
  return qd.defineService(taskContract, {
    model: "task",
    access: inherit({ from: projectContract, via: "projectId" }),
    affects: [{ service: taskContract, id: "parentTaskId" }],
    versionColumn: options.versionColumn,
    methods: {
      get: { access: { entry: "Read" }, handler: ({ input, db }) => findTask(db, input.id) },
      getShared: {
        access: { entry: "Read" },
        share: "all",
        handler: async ({ input, db }) => {
          gate.runs += 1;
          await gate.wait;
          return await findTask(db, input.id);
        },
      },
      rename: {
        access: "authenticated",
        rowless: true,
        handler: async ({ input, db }) => {
          await db.task.update({ where: { id: input.id }, data: { title: input.title } });
          return null;
        },
      },
      renameTenTimes: {
        access: "authenticated",
        rowless: true,
        handler: async ({ input, db }) => {
          for (let round = 1; round <= 10; round += 1) {
            await db.task.update({ where: { id: input.id }, data: { title: `Round ${round}` } });
          }
          return null;
        },
      },
      setNotes: {
        access: "authenticated",
        rowless: true,
        handler: async ({ input, db }) => {
          await db.task.update({ where: { id: input.id }, data: { notes: input.notes } });
          return null;
        },
      },
      setStatus: {
        access: "authenticated",
        rowless: true,
        handler: async ({ input, db }) => {
          await db.task.update({ where: { id: input.id }, data: { status: input.status } });
          return null;
        },
      },
      addChild: {
        access: "authenticated",
        handler: async ({ input, db }) => {
          const parent = await findTask(db, input.parentTaskId);
          const child = await db.task.create({
            data: { projectId: parent.projectId, parentTaskId: parent.id, title: "Child" },
          });
          return child.id;
        },
      },
      recreate: {
        access: "authenticated",
        rowless: true,
        handler: async ({ input, db }) => {
          const old = await db.task.delete({ where: { id: input.id } });
          await db.task.create({
            data: { id: old.id, projectId: old.projectId, title: "Recreated" },
          });
          return null;
        },
      },
      remove: {
        access: "authenticated",
        rowless: true,
        handler: async ({ input, db }) => {
          await db.task.delete({ where: { id: input.id } });
          return null;
        },
      },
      touch: {
        access: "authenticated",
        rowless: true,
        handler: ({ input, ctx }) => {
          ctx.touch("task", input.id);
          return null;
        },
      },
    },
  });
}

/** A second service on the task model: a card whose `label` is computed by `map`. */
export const cardContract = defineContract("cardService", {
  entity: z.object({ id: z.string(), title: z.string(), label: z.string() }),
  methods: { get: query({ input: id, output: "entity" }) },
});

interface CardSource {
  readonly id: string;
  readonly title: string;
  readonly status: string;
}

export const cardService = qd.defineService(cardContract, {
  model: "task",
  access: inherit({ from: projectContract, via: "projectId" }),
  project: {
    entity: {
      select: { title: true, status: true },
      map: (row: CardSource) => ({
        id: row.id,
        title: row.title,
        label: `${row.status}: ${row.title}`,
      }),
    },
  },
  methods: {
    get: {
      access: { entry: "Read" },
      handler: ({ input, db }) =>
        db.task.findUniqueOrThrow({
          where: { id: input.id },
          select: { id: true, title: true, status: true },
        }),
    },
  },
});

/** One `findMany` the framework made. */
export interface Read {
  readonly model: string;
  readonly args: Readonly<Record<string, unknown>>;
}

/**
 * A storage adapter that records every `findMany` the framework makes
 * through it. `after`, when given, runs once a read has returned and before
 * its rows are handed back, so a test can make something happen in between;
 * `before` runs before the read is made.
 */
export function recordingStorage(
  storage: StorageAdapter,
  after?: (read: Read) => Promise<void> | undefined,
  before?: (read: Read) => Promise<void> | undefined,
) {
  const reads: Read[] = [];
  const recording: StorageAdapter = Object.freeze({
    ...storage,
    findMany: async (model: string, args?: Readonly<Record<string, unknown>>) => {
      const read = { model, args: args ?? {} };
      reads.push(read);
      await before?.(read);
      const rows = await storage.findMany(model, args);
      await after?.(read);
      return rows;
    },
  });
  return { storage: recording, reads };
}

/** True for a read of task rows with the task entity's select: a subscribe's or a flush's row read. */
export function isTaskRowRead(read: Read): boolean {
  const select = read.args.select;
  return (
    read.model === "task" && typeof select === "object" && select !== null && "title" in select
  );
}

/** The `qd:e` and `qd:revoked` frames a connection receives. */
export interface Received {
  readonly entity: EntityFrame[];
  readonly revoked: RevokedFrame[];
  /** Waits until every frame the server sent before now has arrived. */
  settle(): Promise<void>;
  clear(): void;
}

/** A connected socket: what the frame helpers need of a `TestConnection`. */
type Connected = Pick<TestConnection, "socket">;

export function receive(connection: Connected): Received {
  const entity: EntityFrame[] = [];
  const revoked: RevokedFrame[] = [];
  connection.socket.on("qd:e", (frame: EntityFrame) => entity.push(frame));
  connection.socket.on("qd:revoked", (frame: RevokedFrame) => revoked.push(frame));
  return {
    entity,
    revoked,
    // The socket answers in order: frames sent before this acknowledgement arrive before it.
    settle: async () => {
      await settleCluster();
      await emitWithAck(connection.socket, "qd:unsub", { s: "noService", ids: [] });
    },
    clear: () => {
      entity.length = 0;
      revoked.length = 0;
    },
  };
}

/** Sends `qd:sub` and resolves with the acknowledgement. */
export function sub(
  connection: Connected,
  s: string,
  ids: readonly string[],
  revs?: readonly (number | null)[],
): Promise<unknown> {
  return emitWithAck(
    connection.socket,
    "qd:sub",
    revs === undefined ? { s, ids } : { s, ids, revs },
  );
}
