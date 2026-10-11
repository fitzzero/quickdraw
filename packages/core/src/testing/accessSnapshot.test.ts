// `snapshotAccessMatrix` (RFC 0003 section 13, `accessSnapshot.ts`): the
// whole access matrix of the access tests' board, recorded beside the test
// on the first run and compared on every later one: a changed access form
// or policy fails, naming its cells, until it is accepted. These tests keep
// their snapshot files in a temporary directory.
//
//            owner   access list    members
//   P1       ada     di: Read       bo: Moderate, cy: Read
//   P2       ed      -              -
//   T1 in P1, T2 in P2

import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { defineContract, mutation, query } from "../index";
import { createHarness, type Harness } from "../prisma/__tests__/harness";
import { captureLogger } from "../server/__tests__/fixtures";
import {
  as,
  findTask,
  projectContract,
  projectService,
  qd,
  seedBoard,
  type Board,
} from "../server/access/__tests__/board";
import { anyOf, everyone, inherit, owner, type AnyService, type Principal } from "../server/index";
import {
  accessSnapshotFileOf,
  createTestApp,
  snapshotAccessMatrix,
  type AccessSnapshot,
  type AccessSnapshotRow,
  type TestApp,
} from "./index";

const taskContract = defineContract("taskService", {
  entity: z.object({ id: z.string(), projectId: z.string(), title: z.string() }),
  methods: {
    get: query({ input: z.object({ id: z.string() }), output: "entity" }),
    getMany: query({ input: z.object({ ids: z.array(z.string()) }), output: z.number() }),
    rename: mutation({ input: z.object({ id: z.string(), title: z.string() }), output: "entity" }),
    create: mutation({
      input: z.object({ projectId: z.string(), title: z.string() }),
      output: "entity",
    }),
    remove: mutation({ input: z.object({ id: z.string() }), output: z.null() }),
    ping: query({ input: z.undefined(), output: z.literal("pong") }),
    whoami: query({ input: z.undefined(), output: z.string() }),
  },
});

interface TaskOptions {
  /** `rename`'s form; default `{ entry: "Moderate" }`. */
  readonly rename?: { readonly entry: "Moderate" | "Read" };
  /** Runs in `rename`'s handler. */
  readonly onRename?: () => void;
}

/** The board's tasks. */
function defineTasks(options: TaskOptions = {}) {
  return qd.defineService(taskContract, {
    model: "task",
    access: inherit({ from: projectContract, via: "projectId" }),
    methods: {
      get: { access: { entry: "Read" }, handler: ({ input, db }) => findTask(db, input.id) },
      getMany: {
        access: { entry: "Read", id: "ids" },
        handler: ({ input, db }) => db.task.count({ where: { id: { in: input.ids } } }),
      },
      rename: {
        access: options.rename ?? { entry: "Moderate" },
        handler: ({ input, db }) => {
          options.onRename?.();
          return db.task.update({ where: { id: input.id }, data: { title: input.title } });
        },
      },
      create: {
        access: { scope: "Moderate", of: projectContract, id: "projectId" },
        handler: ({ input, db }) => db.task.create({ data: input }),
      },
      remove: {
        access: { entry: "Moderate" },
        handler: async ({ input, db }) => {
          await db.task.delete({ where: { id: input.id } });
          return null;
        },
      },
      ping: { access: "public", handler: () => "pong" as const },
      whoami: { access: "authenticated", handler: ({ ctx }) => ctx.principal.userId },
    },
  });
}

/** Project memberships: a collection per project, anchored on it, and each user's own. */
const memberContract = defineContract("memberService", {
  entity: z.object({ id: z.string(), projectId: z.string(), userId: z.string(), role: z.string() }),
  methods: {
    get: query({ input: z.object({ id: z.string() }), output: "entity" }),
  },
  collections: {
    byProject: { scope: "projectId", item: "entity", order: [["id", "asc"]] },
    mine: { scope: "userId", item: "entity", order: [["id", "asc"]] },
  },
});

const memberService = qd.defineService(memberContract, {
  model: "projectMember",
  access: owner("userId"),
  collections: { byProject: { anchor: projectContract }, mine: { scopeAccess: "self" } },
  methods: {
    get: {
      access: { entry: "Read" },
      handler: ({ input, db }) => db.projectMember.findUniqueOrThrow({ where: { id: input.id } }),
    },
  },
});

/** Public profiles: each user's own row, read by its owner, or by everyone as given. */
const profileContract = defineContract("profileService", {
  entity: z.object({ id: z.string(), name: z.string() }),
  methods: {
    get: query({ input: z.object({ id: z.string() }), output: "entity" }),
  },
});

function readProfile({
  input,
  db,
}: {
  readonly input: { id: string };
  readonly db: Harness["prisma"];
}) {
  return db.user.findUniqueOrThrow({ where: { id: input.id }, select: { id: true, name: true } });
}

/** Profiles each user reads their own of; or everyone reads every one, by policy or by a rowless method. */
function defineProfiles(variant: "owner" | "everyone" | "rowless") {
  if (variant === "rowless") {
    return qd.defineService(profileContract, {
      model: "user",
      access: owner("id"),
      methods: { get: { access: "authenticated", rowless: true, handler: readProfile } },
    });
  }
  return qd.defineService(profileContract, {
    model: "user",
    access: variant === "everyone" ? anyOf(owner("id"), everyone("Read")) : owner("id"),
    methods: { get: { access: { entry: "Read" }, handler: readProfile } },
  });
}

/** The board, and bo's membership of P1. */
interface Fixture extends Board {
  readonly boInP1: string;
}

const NAMES = ["ada", "bo", "cy", "di", "ed"] as const;

/** A row of the matrix: `"ok"` for the principals named, FORBIDDEN for the others, anonymously UNAUTHENTICATED. */
function only(...allowed: readonly (typeof NAMES)[number][]): AccessSnapshotRow {
  return Object.fromEntries([
    ...NAMES.map((name) => [name, allowed.includes(name) ? "ok" : "FORBIDDEN"]),
    ["anonymous", "UNAUTHENTICATED"],
  ]) as AccessSnapshotRow;
}

/** Who reads P1 and its tasks, who moderates them, and who reads P2. */
const P1_READERS = only("ada", "bo", "cy", "di");
const P1_MODERATORS = only("ada", "bo");
const P2_READERS = only("ed");

let h: Harness;
let dir: string;
let file: string;
let resets = 0;
const apps: TestApp[] = [];

beforeAll(async () => {
  h = await createHarness();
  dir = mkdtempSync(join(tmpdir(), "qd-access-"));
}, 60_000);

afterAll(async () => {
  await h.close();
  rmSync(dir, { recursive: true, force: true });
});

beforeEach((context) => {
  file = join(dir, `${context.task.id}.test.ts`);
  resets = 0;
  // As a local run, with no update asked for.
  vi.stubEnv("CI", "");
  vi.stubEnv("QD_UPDATE_ACCESS_SNAPSHOT", undefined);
});

afterEach(async () => {
  vi.unstubAllEnvs();
  await Promise.all(apps.splice(0).map(async (app) => await app.close()));
});

async function start(services: readonly AnyService[]) {
  const app = await createTestApp({ services, db: h.db, logger: captureLogger() });
  apps.push(app as unknown as TestApp);
  return app;
}

/** Empties the database and seeds the board. */
async function reset(): Promise<Fixture> {
  resets += 1;
  await h.database.reset();
  const board = await seedBoard(h.prisma);
  const member = await h.prisma.projectMember.findFirstOrThrow({ where: { userId: board.bo } });
  return { ...board, boInP1: member.id };
}

const principals = (board: Fixture): Record<string, Principal> => ({
  ada: as(board.ada),
  bo: as(board.bo),
  cy: as(board.cy),
  di: as(board.di),
  ed: as(board.ed),
});

const rows = (board: Fixture) => ({
  projectService: { p1: board.p1, p2: board.p2 },
  taskService: { t1: board.t1, t2: board.t2 },
  memberService: board.boInP1,
});

/** The options of a board matrix, with the snapshot in the test's own file. */
const matrix = {
  principals,
  reset,
  rows,
  get file() {
    return file;
  },
};

/** The options of a matrix of profiles alone: ada's is the row. */
const profiles = {
  ...matrix,
  rows: (board: Fixture) => ({ profileService: board.ada }),
  get file() {
    return file;
  },
};

function stored(): AccessSnapshot {
  return JSON.parse(readFileSync(accessSnapshotFileOf(file), "utf8")) as AccessSnapshot;
}

/** What `snapshotAccessMatrix` rejected with. */
async function failure(run: Promise<unknown>): Promise<string> {
  const error: unknown = await run.then(
    () => undefined,
    (reason: unknown) => reason,
  );
  expect(error).toBeInstanceOf(Error);
  return (error as Error).message;
}

// Each case resets the PGlite database after every mutation that got past
// access, so one case can take several seconds on a slow CI runner.
describe("snapshotAccessMatrix", { timeout: 30_000 }, () => {
  it("records every method, subscribe and scope as every principal on the first run", async () => {
    const app = await start([projectService, defineTasks(), memberService]);
    const report = await snapshotAccessMatrix(app, matrix);
    const expected: AccessSnapshot = {
      version: 1,
      principals: {
        ada: { kind: null },
        bo: { kind: null },
        cy: { kind: null },
        di: { kind: null },
        ed: { kind: null },
        anonymous: null,
      },
      methods: {
        "memberService.get": only("bo"),
        "projectService.get (p1)": P1_READERS,
        "projectService.get (p2)": P2_READERS,
        "taskService.create (p1)": P1_MODERATORS,
        "taskService.create (p2)": P2_READERS,
        "taskService.get (t1)": P1_READERS,
        "taskService.get (t2)": P2_READERS,
        "taskService.getMany (t1)": P1_READERS,
        "taskService.getMany (t2)": P2_READERS,
        "taskService.ping": { ...only(...NAMES), anonymous: "ok" },
        "taskService.remove (t1)": P1_MODERATORS,
        "taskService.remove (t2)": P2_READERS,
        "taskService.rename (t1)": P1_MODERATORS,
        "taskService.rename (t2)": P2_READERS,
        "taskService.whoami": only(...NAMES),
      },
      subscriptions: {
        memberService: only("bo"),
        "projectService (p1)": P1_READERS,
        "projectService (p2)": P2_READERS,
        "taskService (t1)": P1_READERS,
        "taskService (t2)": P2_READERS,
      },
      collections: {
        "memberService.byProject (p1)": P1_READERS,
        "memberService.byProject (p2)": P2_READERS,
        "memberService.mine (self)": only(...NAMES),
      },
      excluded: [],
    };
    expect(report).toEqual({
      path: accessSnapshotFileOf(file),
      change: "written",
      snapshot: expected,
      inconclusive: [],
    });
    expect(stored()).toEqual(expected);
    const text = readFileSync(report.path, "utf8");
    expect(text.endsWith("}\n")).toBe(true);
    expect(Object.keys(JSON.parse(text) as object)).toEqual([
      "collections",
      "excluded",
      "methods",
      "principals",
      "subscriptions",
      "version",
    ]);
    // Once to start, and after each of the 9 mutations access let through:
    // create, remove and rename, each by ada and bo on P1 and by ed on P2.
    // Each remove found its task: every cell saw the rows the seed made.
    expect(resets).toBe(10);
  });

  it("passes unchanged while the matrix stays the same", async () => {
    const app = await start([projectService, defineTasks(), memberService]);
    await snapshotAccessMatrix(app, matrix);
    const before = readFileSync(accessSnapshotFileOf(file), "utf8");
    const again = await snapshotAccessMatrix(app, matrix);
    expect(again.change).toBe("unchanged");
    expect(readFileSync(again.path, "utf8")).toBe(before);
  });

  it("fails naming each cell a changed access form changes, and whether it opens access", async () => {
    const services = [projectService, memberService];
    await snapshotAccessMatrix(await start([...services, defineTasks()]), matrix);
    const before = readFileSync(accessSnapshotFileOf(file), "utf8");
    const loosened = await start([...services, defineTasks({ rename: { entry: "Read" } })]);
    const message = await failure(snapshotAccessMatrix(loosened, matrix));
    expect(message).toBe(
      [
        `snapshotAccessMatrix: 2 cells differ from the access snapshot (${accessSnapshotFileOf(file)}):`,
        "  taskService.rename (t1) as cy: FORBIDDEN → ok (opens access)",
        "  taskService.rename (t1) as di: FORBIDDEN → ok (opens access)",
        "If every change is meant, run the tests again with QD_UPDATE_ACCESS_SNAPSHOT=1, review the file and commit it.",
      ].join("\n"),
    );
    expect(readFileSync(accessSnapshotFileOf(file), "utf8")).toBe(before);
  });

  it("accepts the changes with QD_UPDATE_ACCESS_SNAPSHOT=1, then fails the way back as closing access", async () => {
    const services = [projectService, memberService];
    await snapshotAccessMatrix(await start([...services, defineTasks()]), matrix);
    vi.stubEnv("QD_UPDATE_ACCESS_SNAPSHOT", "1");
    const loosened = await start([...services, defineTasks({ rename: { entry: "Read" } })]);
    const accepted = await snapshotAccessMatrix(loosened, matrix);
    expect(accepted.change).toBe("updated");
    expect(stored().methods["taskService.rename (t1)"]).toEqual(P1_READERS);
    vi.stubEnv("QD_UPDATE_ACCESS_SNAPSHOT", undefined);
    expect((await snapshotAccessMatrix(loosened, matrix)).change).toBe("unchanged");
    const tightened = await start([...services, defineTasks()]);
    const message = await failure(snapshotAccessMatrix(tightened, matrix));
    expect(message).toContain("taskService.rename (t1) as cy: ok → FORBIDDEN (closes access)");
    expect(message).toContain("taskService.rename (t1) as di: ok → FORBIDDEN (closes access)");
  });

  it("shows a policy that lets everyone read as cells of the method and the subscribe", async () => {
    const owned = defineProfiles("owner");
    await snapshotAccessMatrix(await start([owned]), { ...profiles, services: [owned] });
    expect(stored().methods["profileService.get"]).toEqual(only("ada"));
    const everyoneReads = defineProfiles("everyone");
    const message = await failure(
      snapshotAccessMatrix(await start([everyoneReads]), {
        ...profiles,
        services: [everyoneReads],
      }),
    );
    for (const name of ["bo", "cy", "di", "ed"]) {
      expect(message).toContain(`  profileService.get as ${name}: FORBIDDEN → ok (opens access)`);
      expect(message).toContain(
        `  qd:sub profileService as ${name}: FORBIDDEN → ok (opens access)`,
      );
    }
    expect(message).toContain("8 cells differ");
  });

  it("shows a method that reads any row (rowless) as cells, beside the subscribe it leaves alone", async () => {
    const owned = defineProfiles("owner");
    await snapshotAccessMatrix(await start([owned]), { ...profiles, services: [owned] });
    const rowless = defineProfiles("rowless");
    const message = await failure(
      snapshotAccessMatrix(await start([rowless]), { ...profiles, services: [rowless] }),
    );
    expect(message).toContain("4 cells differ");
    expect(message).toContain("  profileService.get as bo: FORBIDDEN → ok (opens access)");
    expect(message).not.toContain("qd:sub");
  });

  it("records each principal's kind, and fails when one changes", async () => {
    const owned = defineProfiles("owner");
    const app = await start([owned]);
    const kinds = (agent: string) => (board: Fixture) => ({
      ada: { userId: board.ada, kind: "user" },
      bo: { userId: board.bo, kind: agent },
      guest: null,
    });
    await snapshotAccessMatrix(app, { ...profiles, services: [owned], principals: kinds("user") });
    expect(stored().principals).toEqual({
      ada: { kind: "user" },
      bo: { kind: "user" },
      guest: null,
    });
    const message = await failure(
      snapshotAccessMatrix(app, { ...profiles, services: [owned], principals: kinds("agent") }),
    );
    expect(message).toContain("1 principal differs");
    expect(message).toContain("  principal bo: kind user → kind agent");
  });

  it("writes added and removed cells locally, and fails on them, or on a missing file, under CI", async () => {
    const tasks = defineTasks();
    const app = await start([projectService, tasks, memberService]);
    vi.stubEnv("CI", "true");
    const missing = await failure(snapshotAccessMatrix(app, matrix));
    expect(missing).toContain("there is no access snapshot at");
    expect(missing).toContain("a snapshot that writes itself pins nothing");
    expect(existsSync(accessSnapshotFileOf(file))).toBe(false);
    vi.stubEnv("CI", "");
    await snapshotAccessMatrix(app, { ...matrix, services: [projectService, tasks] });
    const added = await snapshotAccessMatrix(app, matrix);
    expect(added.change).toBe("updated");
    expect(stored().collections["memberService.mine (self)"]).toEqual(only(...NAMES));
    vi.stubEnv("CI", "1");
    const removed = await failure(
      snapshotAccessMatrix(app, { ...matrix, services: [projectService, tasks] }),
    );
    expect(removed).toContain("the access matrix has other cells than its snapshot");
    expect(removed).toContain("  removed: memberService.get");
    expect(removed).toContain("  removed: qd:sub memberService");
    expect(removed).toContain("  removed: qd:col:sub memberService.mine (self)");
    expect(stored().methods).toHaveProperty(["memberService.get"]);
  });

  it("never writes under CI, even when QD_UPDATE_ACCESS_SNAPSHOT asks", async () => {
    const owned = defineProfiles("owner");
    const app = await start([owned]);
    vi.stubEnv("CI", "1");
    vi.stubEnv("QD_UPDATE_ACCESS_SNAPSHOT", "1");
    const message = await failure(snapshotAccessMatrix(app, { ...profiles, services: [owned] }));
    expect(message).toContain("QD_UPDATE_ACCESS_SNAPSHOT is set under CI");
    expect(existsSync(accessSnapshotFileOf(file))).toBe(false);
  });

  it("leaves out excluded methods and lists them; an exclusion names a method of the matrix", async () => {
    const tasks = defineTasks();
    const app = await start([projectService, tasks, memberService]);
    const options = { ...matrix, services: [projectService, tasks] };
    const report = await snapshotAccessMatrix(app, {
      ...options,
      exclude: ["taskService.ping", "taskService.remove"],
    });
    expect(report.snapshot.excluded).toEqual(["taskService.ping", "taskService.remove"]);
    expect(Object.keys(report.snapshot.methods)).not.toContain("taskService.ping");
    expect(Object.keys(report.snapshot.methods)).not.toContain("taskService.remove (t1)");
    await expect(
      snapshotAccessMatrix(app, { ...options, exclude: ["memberService.get"] }),
    ).rejects.toThrow(
      "exclude names memberService.get, which is no method (<service>.<method>) of the matrix's services",
    );
  });

  it("takes the inputs the app gives, and records one its schema refuses as inconclusive, uncalled", async () => {
    let renames = 0;
    const tasks = defineTasks({
      onRename: () => {
        renames += 1;
      },
    });
    const app = await start([projectService, tasks]);
    const report = await snapshotAccessMatrix(app, {
      ...matrix,
      rows: (board) => ({ projectService: board.p1, taskService: board.t1 }),
      inputs: (ref) => {
        if (ref.method === "rename") {
          return { id: ref.row, title: 42 };
        }
        return ref.method === "getMany" ? { ids: [ref.row, ref.row] } : undefined;
      },
    });
    expect(renames).toBe(0);
    expect(report.snapshot.methods["taskService.rename"]).toEqual(
      Object.fromEntries([...NAMES, "anonymous"].map((name) => [name, "VALIDATION"])),
    );
    expect(report.inconclusive).toEqual(
      [...NAMES, "anonymous"].map((name) => `taskService.rename as ${name}`),
    );
    expect(report.snapshot.methods["taskService.getMany"]).toEqual(P1_READERS);
  });

  it("refuses rows that name no row of a service a cell is about, listing every one", async () => {
    const app = await start([projectService, defineTasks(), memberService]);
    await expect(
      snapshotAccessMatrix(app, {
        ...matrix,
        rows: (board) => ({ taskService: board.t1, memberService: board.boInP1 }),
      }),
    ).rejects.toThrow(
      "snapshotAccessMatrix: rows names no row of projectService (for projectService.get, taskService.create, qd:sub projectService, qd:col:sub memberService.byProject).",
    );
    await expect(
      snapshotAccessMatrix(app, { ...matrix, rows: (board) => ({ ...rows(board), nope: "x" }) }),
    ).rejects.toThrow("rows names nope, which the app does not serve");
  });

  it("adds the anonymous caller unless one is null, and keeps the principals' names over resets", async () => {
    const owned = defineProfiles("owner");
    const app = await start([owned]);
    await expect(
      snapshotAccessMatrix(app, {
        ...profiles,
        services: [owned],
        principals: (board) => ({ anonymous: as(board.ada) }),
      }),
    ).rejects.toThrow('a principal is named "anonymous"');
    const tasks = defineTasks();
    const other = await start([projectService, tasks]);
    let named = 0;
    await expect(
      snapshotAccessMatrix(other, {
        ...matrix,
        services: [tasks],
        rows: (board) => ({ projectService: board.p1, taskService: board.t1 }),
        principals: (board): Record<string, Principal> => {
          named += 1;
          return named === 1 ? { ada: as(board.ada) } : { bo: as(board.bo) };
        },
      }),
    ).rejects.toThrow("principals and rows must name the same principals");
  });

  it("refuses a file that is not an access snapshot", async () => {
    const owned = defineProfiles("owner");
    const app = await start([owned]);
    await snapshotAccessMatrix(app, { ...profiles, services: [owned] });
    writeFileSync(accessSnapshotFileOf(file), JSON.stringify({ version: 2 }));
    await expect(snapshotAccessMatrix(app, { ...profiles, services: [owned] })).rejects.toThrow(
      "is not an access snapshot",
    );
  });
});

describe("one snapshot per test file", () => {
  const shared = (): string => join(dir, "shared.test.ts");

  it("lets a test take its file's snapshot, again on a retry", async () => {
    const owned = defineProfiles("owner");
    const app = await start([owned]);
    const options = { ...profiles, services: [owned], file: shared() };
    await snapshotAccessMatrix(app, options);
    expect((await snapshotAccessMatrix(app, options)).change).toBe("unchanged");
  });

  it("refuses a second test of the file", async () => {
    const owned = defineProfiles("owner");
    const app = await start([owned]);
    await expect(
      snapshotAccessMatrix(app, { ...profiles, services: [owned], file: shared() }),
    ).rejects.toThrow("two tests take an access snapshot into");
  });
});
