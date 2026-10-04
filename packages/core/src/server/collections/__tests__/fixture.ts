// The collection tests' services, on the access tests' board
// (`../../access/__tests__/board.ts`) and the live-data tests' project
// service (`../../emit/__tests__/live.ts`): a task service whose collections
// cover each kind of scope, an indexed board (and an indexed mapped item) for
// whole-scope loading, a query that watches a scope's change topic, and a
// label service the `via` collections are anchored on (one of them,
// `taggedByLabel`, counts the junction's rows and declares `refreshEntry`).
//
//            owner   access list    members
//   P1       ada     di: Read       bo: Moderate, cy: Read
//   P2       ed      -              -
//   T1 in P1, T2 in P2

import { z } from "zod";
import { settleCluster } from "../../../../test/cluster/mode";
import type { PrismaClient } from "../../../../test/prisma/setup";
import {
  defineContract,
  mutation,
  query,
  via,
  type ChangedFrame,
  type CollectionFrame,
  type RevokedFrame,
} from "../../../index";
import { emitWithAck, type TestConnection } from "../../../testing/index";
import { inherit, type WatchAccess } from "../../index";
import { findTask } from "../../access/__tests__/board";
import { projectContract, qd } from "../../emit/__tests__/live";

export const cardSchema = z.object({
  id: z.string(),
  projectId: z.string(),
  title: z.string(),
  status: z.string(),
  ordinal: z.number(),
});

/** The card's keys, in schema order: what a card item holds. */
export const CARD_KEYS = Object.keys(cardSchema.shape);

/** A board tile: a card with its assignee and the version column. */
export const tileSchema = cardSchema.extend({
  assigneeId: z.string().nullable(),
  updatedAt: z.string(),
});

/** The board's index fields, in the order the contract declares them. */
export const BOARD_INDEX = ["status", "ordinal", "assigneeId"] as const;

/** A task with how many labels it has: an item computed from the TaskLabel junction. */
export const taggedSchema = z.object({
  id: z.string(),
  title: z.string(),
  labelCount: z.number(),
});

export const taskContract = defineContract("taskService", {
  entity: z.object({
    id: z.string(),
    projectId: z.string(),
    parentTaskId: z.string().nullable(),
    title: z.string(),
    status: z.string(),
    ordinal: z.number(),
    assigneeId: z.string().nullable(),
    notes: z.string().nullable(),
    updatedAt: z.string(),
  }),
  projections: {
    card: cardSchema,
    label: z.object({ id: z.string(), label: z.string() }),
    tile: tileSchema,
    tagged: taggedSchema,
  },
  fields: { notes: "Admin" },
  methods: {
    get: query({ input: z.object({ id: z.string() }), output: "entity" }),
    /** How many tasks a project has: a query that watches the board's scope. */
    countOnBoard: query({
      input: z.object({ projectId: z.string() }),
      output: z.number(),
      watch: { collection: "board", scope: (input) => input.projectId },
    }),
    /** Ten writes to one task in one call. */
    renameTenTimes: mutation({ input: z.object({ id: z.string() }), output: z.null() }),
  },
  collections: {
    /** A whole board: every task of a project, indexed, in pages of 10. */
    board: {
      scope: "projectId",
      item: "tile",
      order: [
        ["ordinal", "asc"],
        ["id", "asc"],
      ],
      limit: 10,
      index: [...BOARD_INDEX],
      views: { mine: (row, who) => row.assigneeId === who.userId },
    },
    /** A mapped item with an index: its index rows come from the map too. */
    labelBoard: {
      scope: "projectId",
      item: "label",
      order: [["id", "asc"]],
      index: ["label"],
    },
    /** Every task of a project, by ordinal. */
    byProject: {
      scope: "projectId",
      item: "card",
      order: [
        ["ordinal", "asc"],
        ["id", "asc"],
      ],
    },
    /** The open tasks of a project, in pages of 2 and at most 3. */
    openByProject: {
      scope: "projectId",
      item: "card",
      where: { status: "open" },
      order: [
        ["ordinal", "asc"],
        ["id", "asc"],
      ],
      limit: 2,
      maxLimit: 3,
    },
    /** Whole rows, whose Admin-only notes no item carries. */
    rows: { scope: "projectId", item: "entity", order: [["id", "asc"]] },
    /** A mapped item: a change is always sent whole. */
    labelled: { scope: "projectId", item: "label", order: [["id", "asc"]] },
    /** The tasks a label is on, through the TaskLabel junction. */
    byLabel: {
      scope: via({ model: "taskLabel", entry: "taskId", scope: "labelId" }),
      item: "card",
      order: [["id", "asc"]],
    },
    /** The same, with each task's label count: a junction write sends the task again everywhere. */
    taggedByLabel: {
      scope: via({ model: "taskLabel", entry: "taskId", scope: "labelId", refreshEntry: true }),
      item: "tagged",
      order: [["id", "asc"]],
    },
    /** The tasks assigned to the subscriber, newest ordinal first. */
    mine: {
      scope: "assigneeId",
      item: "card",
      order: [
        ["ordinal", "desc"],
        ["id", "asc"],
      ],
    },
    /** Every task of a project, ordered by a column that may hold null. */
    byParent: {
      scope: "projectId",
      item: "card",
      order: [
        ["parentTaskId", "asc"],
        ["id", "asc"],
      ],
    },
  },
});

export const labelContract = defineContract("labelService", {
  entity: z.object({ id: z.string(), projectId: z.string(), name: z.string() }),
});

export const labelService = qd.defineService(labelContract, {
  model: "label",
  access: inherit({ from: projectContract, via: "projectId" }),
  methods: {},
});

interface LabelSource {
  readonly id: string;
  readonly title: string;
  readonly status: string;
}

interface TaggedSource {
  readonly id: string;
  readonly title: string;
  readonly _count: { readonly labels: number };
}

/** Options of {@link defineTaskService}. */
export interface TaskServiceOptions {
  /** For the bulk tests. */
  readonly bulkThreshold?: number;
  /** `"updatedAt"` for index rows whose `rev` is the row's version. */
  readonly versionColumn?: "updatedAt";
  readonly watchAccess?: WatchAccess;
}

/** The task service. */
export function defineTaskService(options: TaskServiceOptions = {}) {
  return qd.defineService(taskContract, {
    model: "task",
    access: inherit({ from: projectContract, via: "projectId" }),
    affects: [{ service: taskContract, id: "parentTaskId" }],
    versionColumn: options.versionColumn,
    watchAccess: options.watchAccess,
    project: {
      label: {
        select: { title: true, status: true },
        map: (row: LabelSource) => ({ id: row.id, label: `${row.status}: ${row.title}` }),
      },
      tagged: {
        select: { title: true, _count: { select: { labels: true } } },
        map: (row: TaggedSource) => ({
          id: row.id,
          title: row.title,
          labelCount: row._count.labels,
        }),
      },
    },
    collections: {
      board: { anchor: projectContract },
      labelBoard: { anchor: projectContract },
      byProject: { anchor: projectContract, bulkThreshold: options.bulkThreshold },
      openByProject: { anchor: projectContract },
      rows: { anchor: projectContract },
      labelled: { anchor: projectContract },
      byLabel: { anchor: labelContract },
      taggedByLabel: { anchor: labelContract },
      mine: { scopeAccess: "self" },
      byParent: { anchor: projectContract },
    },
    methods: {
      get: { access: { entry: "Read" }, handler: ({ input, db }) => findTask(db, input.id) },
      countOnBoard: {
        access: { scope: "Read", of: projectContract, id: "projectId" },
        handler: ({ input, db }) => db.task.count({ where: { projectId: input.projectId } }),
      },
      renameTenTimes: {
        access: { entry: "Moderate" },
        handler: async ({ input, db }) => {
          for (let round = 1; round <= 10; round += 1) {
            await db.task.update({ where: { id: input.id }, data: { title: `Round ${round}` } });
          }
          return null;
        },
      },
    },
  });
}

/** Tasks of `projectId` with ordinals `ordinals`, written untracked; their ids in that order. */
export async function addTasks(
  prisma: PrismaClient,
  projectId: string,
  ordinals: readonly number[],
  data: { readonly status?: string; readonly assigneeId?: string } = {},
): Promise<string[]> {
  const ids: string[] = [];
  for (const ordinal of ordinals) {
    const task = await prisma.task.create({
      data: { projectId, title: `Task ${ordinal}`, ordinal, ...data },
    });
    ids.push(task.id);
  }
  return ids;
}

/** The `qd:c`, `qd:changed` and `qd:revoked` frames a connection receives. */
export interface Scopes {
  readonly frames: CollectionFrame[];
  readonly changed: ChangedFrame[];
  readonly revoked: RevokedFrame[];
  /** Waits until every frame the server sent before now has arrived. */
  settle(): Promise<void>;
  clear(): void;
}

type Connected = Pick<TestConnection, "socket">;

export function receiveScopes(connection: Connected): Scopes {
  const frames: CollectionFrame[] = [];
  const changed: ChangedFrame[] = [];
  const revoked: RevokedFrame[] = [];
  connection.socket.on("qd:c", (frame: CollectionFrame) => frames.push(frame));
  connection.socket.on("qd:changed", (frame: ChangedFrame) => changed.push(frame));
  connection.socket.on("qd:revoked", (frame: RevokedFrame) => revoked.push(frame));
  return {
    frames,
    changed,
    revoked,
    // The socket answers in order: frames sent before this acknowledgement arrive before it.
    settle: async () => {
      await settleCluster();
      await emitWithAck(connection.socket, "qd:col:unsub", { s: "none", c: "none", scope: "none" });
    },
    clear: () => {
      frames.length = 0;
      changed.length = 0;
      revoked.length = 0;
    },
  };
}

/** Sends `qd:col:sub` and resolves with the acknowledgement. */
export function colSub(
  connection: Connected,
  c: string,
  scope: string,
  options: { readonly since?: number; readonly limit?: number; readonly cursor?: string } = {},
): Promise<Record<string, unknown>> {
  return emitWithAck(connection.socket, "qd:col:sub", { s: "taskService", c, scope, ...options });
}

/** Sends `qd:col:unsub` and resolves with the acknowledgement. */
export function colUnsub(connection: Connected, c: string, scope: string): Promise<unknown> {
  return emitWithAck(connection.socket, "qd:col:unsub", { s: "taskService", c, scope });
}

/** Sends `qd:col:items` and resolves with the acknowledgement. */
export function colItems(
  connection: Connected,
  c: string,
  scope: string,
  ids: readonly string[],
): Promise<Record<string, unknown>> {
  return emitWithAck(connection.socket, "qd:col:items", { s: "taskService", c, scope, ids });
}

/** Sends `qd:watch` for a topic of the task service and resolves with the acknowledgement. */
export function watch(connection: Connected, topic: string, s = "taskService"): Promise<unknown> {
  return emitWithAck(connection.socket, "qd:watch", { s, topic });
}

/** Sends `qd:unwatch` and resolves with the acknowledgement. */
export function unwatch(connection: Connected, topic: string, s = "taskService"): Promise<unknown> {
  return emitWithAck(connection.socket, "qd:unwatch", { s, topic });
}
