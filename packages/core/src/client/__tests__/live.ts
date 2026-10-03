// The live client tests' server: the access tests' board on PGlite
// (`../../server/access/__tests__/board.ts`), the live-data tests' project
// service, and a task service whose queries watch the board's change topic
// and whose `rename` returns the entity, so it is optimistic by default.
// Writes are tracked, so a flush sends real `qd:changed` frames.
//
//            owner   access list    members
//   P1       ada     di: Read       bo: Moderate, cy: Read
//   P2       ed      -              -
//   T1 in P1, T2 in P2

import { afterAll, afterEach, beforeAll, beforeEach } from "vitest";
import { z } from "zod";
import { collectionTopic, defineContract, listOf, mutation, query, topicRoom } from "../../index";
import { createHarness, type Harness } from "../../prisma/__tests__/harness";
import { QuickdrawError } from "../../protocol/errors";
import { findTask, seedBoard, type Board } from "../../server/access/__tests__/board";
import { deferred } from "../../server/__tests__/fixtures";
import {
  projectContract,
  projectService,
  qd,
  recordingStorage,
} from "../../server/emit/__tests__/live";
import { inherit, type CallRecord, type LimitsOptions } from "../../server/index";
import { createTestApp, type TestApp } from "../../testing/index";
import type { CallEnvelope } from "../../protocol/envelope";

const id = z.object({ id: z.string() });
const byProject = z.object({ projectId: z.string() });

export const taskContract = defineContract("taskService", {
  entity: z.object({
    id: z.string(),
    projectId: z.string(),
    title: z.string(),
    status: z.string(),
    ordinal: z.number(),
  }),
  projections: { card: z.object({ id: z.string(), title: z.string() }) },
  methods: {
    get: query({ input: id, output: "entity" }),
    /** How many tasks a project has: watches the board's scope. */
    countOnBoard: query({
      input: byProject,
      output: z.number(),
      watch: { collection: "board", scope: (input) => input.projectId },
    }),
    /** The project's cards: watches the same topic. */
    cards: query({
      input: byProject,
      output: listOf("card"),
      watch: { collection: "board", scope: (input) => input.projectId },
    }),
    /** Waits for the gate; the title "conflict" is refused with CONFLICT. */
    rename: mutation({ input: z.object({ id: z.string(), title: z.string() }), output: "entity" }),
    /** Ten writes to one task in one call: one flush. */
    renameTenTimes: mutation({ input: id, output: z.null() }),
  },
  collections: {
    board: {
      scope: "projectId",
      item: "card",
      order: [
        ["ordinal", "asc"],
        ["id", "asc"],
      ],
    },
    /** The open tasks of a project: a second topic per project. */
    open: {
      scope: "projectId",
      item: "card",
      where: { status: "open" },
      order: [
        ["ordinal", "asc"],
        ["id", "asc"],
      ],
    },
  },
});

/** Holds `rename` before it writes, until the returned function runs. */
export interface Gate {
  hold(): () => void;
  wait(): Promise<void>;
}

function createGate(): Gate {
  let opened: Promise<void> = Promise.resolve();
  return {
    hold() {
      const closed = deferred();
      opened = closed.promise;
      return () => {
        opened = Promise.resolve();
        closed.resolve();
      };
    },
    wait: () => opened,
  };
}

function defineTaskService(gate: Gate) {
  return qd.defineService(taskContract, {
    model: "task",
    access: inherit({ from: projectContract, via: "projectId" }),
    collections: { board: { anchor: projectContract }, open: { anchor: projectContract } },
    methods: {
      get: { access: { entry: "Read" }, handler: ({ input, db }) => findTask(db, input.id) },
      countOnBoard: {
        access: { scope: "Read", of: projectContract, id: "projectId" },
        handler: ({ input, db }) => db.task.count({ where: { projectId: input.projectId } }),
      },
      cards: {
        access: { scope: "Read", of: projectContract, id: "projectId" },
        handler: ({ input, db }) =>
          db.task.findMany({
            where: { projectId: input.projectId },
            orderBy: [{ ordinal: "asc" }, { id: "asc" }],
            take: 100,
          }),
      },
      rename: {
        access: { entry: "Moderate" },
        handler: async ({ input, db }) => {
          await gate.wait();
          if (input.title === "conflict") {
            throw new QuickdrawError("CONFLICT", "That title is taken");
          }
          return await db.task.update({ where: { id: input.id }, data: { title: input.title } });
        },
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

/** Options of a live server: its limits, and a hook run before each storage read. */
export interface LiveOptions {
  readonly limits?: LimitsOptions;
  readonly beforeRead?: () => Promise<void> | undefined;
}

/** The live test harness: call once per test file. Each test gets a fresh board. */
export function liveHarness() {
  let h: Harness | undefined;
  let seeded: Board | undefined;
  const apps: TestApp[] = [];

  beforeAll(async () => {
    h = await createHarness();
  }, 60_000);
  afterAll(async () => {
    await h?.close();
  });
  beforeEach(async () => {
    await h?.database.reset();
    seeded = h === undefined ? undefined : await seedBoard(h.prisma);
  });
  afterEach(async () => {
    await Promise.all(apps.splice(0).map(async (app) => await app.close()));
  });

  function harness(): Harness {
    if (h === undefined) {
      throw new Error("the live harness has no database yet");
    }
    return h;
  }

  return {
    /** The board seeded for this test. */
    board(): Board {
      if (seeded === undefined) {
        throw new Error("the board is seeded before each test");
      }
      return seeded;
    },
    /** An untracked client on the test database. */
    prisma: () => harness().prisma,
    /** Starts a server with the project and task services; `records` are its completed calls. */
    async start(options: LiveOptions = {}) {
      const gate = createGate();
      const records: CallRecord[] = [];
      const { storage } = recordingStorage(harness().storage, undefined, options.beforeRead);
      const app = await createTestApp({
        services: [projectService, defineTaskService(gate)],
        db: harness().db,
        storage,
        onCall: (record) => records.push(record),
        ...(options.limits === undefined ? {} : { limits: options.limits }),
      });
      apps.push(app as unknown as TestApp);
      return { app, records, gate };
    },
  };
}

/** A test app's rooms, as `watchersOf` reads them. */
interface WithRooms {
  readonly server: {
    readonly io: {
      readonly sockets: {
        readonly adapter: { readonly rooms: ReadonlyMap<string, ReadonlySet<string>> };
      };
    };
  };
}

/** How many sockets are in the room of the topic of `collection` (default the board) of `projectId`. */
export function watchersOf(app: WithRooms, projectId: string, collection = "board"): number {
  const room = topicRoom("taskService", collectionTopic(collection, projectId));
  return app.server.io.sockets.adapter.rooms.get(room)?.size ?? 0;
}

/** The `qd:call` envelopes among `sent` (from `outgoing`) of method `m`. */
export function callsOf(sent: readonly unknown[][], m: string): CallEnvelope[] {
  return sent
    .filter(([event]) => event === "qd:call")
    .map(([, envelope]) => envelope as CallEnvelope)
    .filter((envelope) => envelope.m === m);
}

/** The frames among `sent` (from `outgoing`) of `event`. */
export function framesOf(sent: readonly unknown[][], event: string): unknown[] {
  return sent.filter(([name]) => name === event).map(([, frame]) => frame);
}
