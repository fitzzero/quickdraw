// The end-to-end suite's app (RFC 0003 section 13), used by every file in
// `test/e2e/`. It is booted the way production boots an app: its services
// on `createServer` (through `createTestApp`), on a tracked Prisma client
// over the PGlite test schema, so every write sends the frames an app's
// users would get. It reuses the board the access tests seed
// (`src/server/access/__tests__/board.ts`) and the live-data tests' project
// service (`src/server/emit/__tests__/live.ts`), and adds a task service
// made for these tests:
//
// - an entity with an `Admin`-only `notes` field;
// - `countOnBoard`, a query that watches its project's board topic;
// - entity-returning mutations, so the client applies them optimistically:
//   `rename` waits for the test's gate and refuses the title "conflict";
// - `board`, every task of a project, indexed, with the view `mine`;
// - the kits' `list` (cards, filtered by project and status) and `search`
//   (in titles), which the budgets test measures.
//
//            owner   access list    members                 level on its tasks
//   P1       ada     di: Read       bo: Moderate, cy: Read  ada Admin, bo Moderate, cy and di Read
//   P2       ed      -              -                       ed Admin
//   P3       ada     -              -                       ada Admin
//   T1 in P1, T2 in P2
//
// Packs E and G and the quickdraw-chat migration lean on this suite: keep the
// app small and its behavior stable.

import { afterAll, afterEach, beforeAll, beforeEach } from "vitest";
import { z } from "zod";
import { QuickdrawError, crud, defineContract, mutation, query, search } from "../../src/index";
import { createHarness, type Harness } from "../../src/prisma/__tests__/harness";
import { findTask, seedBoard, type Board } from "../../src/server/access/__tests__/board";
import {
  projectContract,
  projectService,
  qd,
  recordingStorage,
} from "../../src/server/emit/__tests__/live";
import {
  crud as crudKit,
  inherit,
  search as searchKit,
  type AnyService,
  type CallRecord,
  type FlushSink,
} from "../../src/server/index";
import { createTestApp, type TestApp } from "../../src/testing/index";
import type { PrismaClient } from "../prisma/setup";

export { as } from "../../src/server/access/__tests__/board";
export { projectContract };

const id = z.object({ id: z.string() });
const card = z.object({
  id: z.string(),
  projectId: z.string(),
  title: z.string(),
  status: z.string(),
  ordinal: z.number(),
  assigneeId: z.string().nullable(),
});

const entity = card.extend({ notes: z.string().nullable() });

export const taskContract = defineContract("taskService", {
  entity,
  projections: { card },
  fields: { notes: "Admin" },
  methods: {
    get: query({ input: id, output: "entity" }),
    /** How many tasks a project has: watches the project's board. */
    countOnBoard: query({
      input: z.object({ projectId: z.string() }),
      output: z.number(),
      watch: { collection: "board", scope: (input) => input.projectId },
    }),
    /** `id` is one the client made, which the server keeps: a second call with it fails `CONFLICT`. */
    create: mutation({
      input: z.object({
        id: z.string().optional(),
        projectId: z.string(),
        title: z.string(),
        ordinal: z.number().optional(),
      }),
      output: "entity",
    }),
    /** Waits for the test's gate, as `create` does; the title "conflict" is refused with CONFLICT. */
    rename: mutation({ input: z.object({ id: z.string(), title: z.string() }), output: "entity" }),
    reorder: mutation({
      input: z.object({ id: z.string(), ordinal: z.number() }),
      output: "entity",
    }),
    assign: mutation({
      input: z.object({ id: z.string(), assigneeId: z.string().nullable() }),
      output: "entity",
    }),
    /** Moves a task to another project; only the owner of its project may. */
    move: mutation({
      input: z.object({ id: z.string(), projectId: z.string() }),
      output: "entity",
    }),
    setNotes: mutation({
      input: z.object({ id: z.string(), notes: z.string() }),
      output: "entity",
    }),
    remove: mutation({ input: id, output: z.null() }),
    ...crud.contract({
      entity,
      list: { item: card, filter: ["projectId", "status"], sort: ["ordinal", "title"] },
    }),
    ...search.contract({ entity, item: card, fields: ["title"] }),
  },
  collections: {
    board: {
      scope: "projectId",
      item: "card",
      order: [
        ["ordinal", "asc"],
        ["id", "asc"],
      ],
      index: ["status", "ordinal", "assigneeId"],
      views: { mine: (row, who) => row.assigneeId === who.userId },
    },
  },
});

/** Holds `rename` and `create` before they write, until the returned function runs. */
export interface Gate {
  hold(): () => void;
  wait(): Promise<void>;
}

function createGate(): Gate {
  let opened: Promise<void> = Promise.resolve();
  return {
    hold() {
      let open = (): void => undefined;
      opened = new Promise<void>((resolve) => {
        open = resolve;
      });
      return () => {
        opened = Promise.resolve();
        open();
      };
    },
    wait: () => opened,
  };
}

function defineTaskService(gate: Gate) {
  return qd.defineService(taskContract, {
    model: "task",
    access: inherit({ from: projectContract, via: "projectId" }),
    collections: { board: { anchor: projectContract } },
    methods: {
      get: { access: { entry: "Read" }, handler: ({ input, db }) => findTask(db, input.id) },
      countOnBoard: {
        access: { scope: "Read", of: projectContract, id: "projectId" },
        handler: ({ input, db }) => db.task.count({ where: { projectId: input.projectId } }),
      },
      create: {
        access: { scope: "Moderate", of: projectContract, id: "projectId" },
        handler: async ({ input, db }) => {
          await gate.wait();
          if (input.title === "conflict") {
            throw new QuickdrawError("CONFLICT", "That title is taken");
          }
          return await db.task.create({ data: input });
        },
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
      reorder: {
        access: { entry: "Moderate" },
        handler: ({ input, db }) =>
          db.task.update({ where: { id: input.id }, data: { ordinal: input.ordinal } }),
      },
      assign: {
        access: { entry: "Moderate" },
        handler: ({ input, db }) =>
          db.task.update({ where: { id: input.id }, data: { assigneeId: input.assigneeId } }),
      },
      move: {
        access: { entry: "Admin" },
        handler: ({ input, db }) =>
          db.task.update({ where: { id: input.id }, data: { projectId: input.projectId } }),
      },
      setNotes: {
        access: { entry: "Admin" },
        handler: ({ input, db }) =>
          db.task.update({ where: { id: input.id }, data: { notes: input.notes } }),
      },
      remove: {
        access: { entry: "Moderate" },
        handler: async ({ input, db }) => {
          await db.task.delete({ where: { id: input.id } });
          return null;
        },
      },
      ...crudKit.handlers(taskContract, { access: { list: "authenticated" } }),
      ...searchKit.handlers(taskContract, { access: "authenticated" }),
    },
  });
}

/** The seeded board's ids, with P3. */
export interface E2EBoard extends Board {
  readonly p3: string;
}

async function seed(prisma: PrismaClient): Promise<E2EBoard> {
  const board = await seedBoard(prisma);
  const p3 = await prisma.project.create({ data: { name: "P3", ownerId: board.ada } });
  return { ...board, p3: p3.id };
}

/** Waits `ms` milliseconds. */
export function tick(ms = 0): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

/**
 * What a test adds to the app: services of its own (callable through
 * `app.as(...)` untyped, since the app's type covers the fixture's), and a
 * sink that sees every flush.
 */
export interface StartOptions {
  readonly services?: readonly AnyService[];
  readonly flushSink?: FlushSink;
}

/** Boots the app on `harness`'s database; `records` are its completed calls, `reads` its storage reads. */
async function startApp(harness: Harness, options: StartOptions = {}) {
  const gate = createGate();
  const records: CallRecord[] = [];
  const { storage, reads } = recordingStorage(harness.storage);
  const fixture = [projectService, defineTaskService(gate)] as const;
  const app = await createTestApp({
    services: [...fixture, ...(options.services ?? [])] as unknown as typeof fixture,
    db: harness.db,
    storage,
    onCall: (record) => records.push(record),
    ...(options.flushSink === undefined ? {} : { flushSink: options.flushSink }),
  });
  /** Runs `fn` on the tracked client in a unit of work, as a job does: its writes send frames. */
  const write = <T>(fn: (db: PrismaClient) => Promise<T>): Promise<T> =>
    app.server.dispatcher.run(async () => await fn(harness.db));
  return { app, records, reads, gate, write };
}

/**
 * The suite's harness: call once per test file. Each file gets a PGlite
 * database, each test a freshly seeded board and its own app, closed after
 * the test.
 */
export function e2eApp() {
  let harness: Harness | undefined;
  let seeded: E2EBoard | undefined;
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
      throw new Error("the e2e harness has no database yet");
    }
    return harness;
  };

  return {
    /** The board seeded for this test. */
    board(): E2EBoard {
      if (seeded === undefined) {
        throw new Error("the board is seeded before each test");
      }
      return seeded;
    },
    /** An untracked client on the test database: what is stored, seen past the server. */
    prisma: (): PrismaClient => current().prisma,
    /** Starts this test's app, with the test's own services and flush sink when given. */
    async start(options: StartOptions = {}) {
      const started = await startApp(current(), options);
      apps.push(started.app as unknown as TestApp);
      return started;
    },
  };
}
