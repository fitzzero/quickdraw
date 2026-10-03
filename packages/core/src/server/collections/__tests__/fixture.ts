// The collection tests' services, on the access tests' board
// (`../../access/__tests__/board.ts`) and the live-data tests' project
// service (`../../emit/__tests__/live.ts`): a task service whose collections
// cover each kind of scope, and a label service a `via` collection is
// anchored on.
//
//            owner   access list    members
//   P1       ada     di: Read       bo: Moderate, cy: Read
//   P2       ed      -              -
//   T1 in P1, T2 in P2

import { z } from "zod";
import type { PrismaClient } from "../../../../test/prisma/setup";
import {
  defineContract,
  query,
  via,
  type CollectionFrame,
  type RevokedFrame,
} from "../../../index";
import { emitWithAck, type TestConnection } from "../../../testing/index";
import { inherit } from "../../index";
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
  },
  fields: { notes: "Admin" },
  methods: { get: query({ input: z.object({ id: z.string() }), output: "entity" }) },
  collections: {
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

/** The task service; `bulkThreshold` for the bulk tests. */
export function defineTaskService(options: { readonly bulkThreshold?: number } = {}) {
  return qd.defineService(taskContract, {
    model: "task",
    access: inherit({ from: projectContract, via: "projectId" }),
    affects: [{ service: taskContract, id: "parentTaskId" }],
    project: {
      label: {
        select: { title: true, status: true },
        map: (row: LabelSource) => ({ id: row.id, label: `${row.status}: ${row.title}` }),
      },
    },
    collections: {
      byProject: { anchor: projectContract, bulkThreshold: options.bulkThreshold },
      openByProject: { anchor: projectContract },
      rows: { anchor: projectContract },
      labelled: { anchor: projectContract },
      byLabel: { anchor: labelContract },
      mine: { scopeAccess: "self" },
      byParent: { anchor: projectContract },
    },
    methods: {
      get: { access: { entry: "Read" }, handler: ({ input, db }) => findTask(db, input.id) },
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

/** The `qd:c` and `qd:revoked` frames a connection receives. */
export interface Scopes {
  readonly frames: CollectionFrame[];
  readonly revoked: RevokedFrame[];
  /** Waits until every frame the server sent before now has arrived. */
  settle(): Promise<void>;
  clear(): void;
}

type Connected = Pick<TestConnection, "socket">;

export function receiveScopes(connection: Connected): Scopes {
  const frames: CollectionFrame[] = [];
  const revoked: RevokedFrame[] = [];
  connection.socket.on("qd:c", (frame: CollectionFrame) => frames.push(frame));
  connection.socket.on("qd:revoked", (frame: RevokedFrame) => revoked.push(frame));
  return {
    frames,
    revoked,
    // The socket answers in order: frames sent before this acknowledgement arrive before it.
    settle: async () => {
      await emitWithAck(connection.socket, "qd:col:unsub", { s: "none", c: "none", scope: "none" });
    },
    clear: () => {
      frames.length = 0;
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
