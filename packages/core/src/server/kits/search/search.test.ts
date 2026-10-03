// The search kit (RFC 0003 section 12.2) through a real server against
// PGlite: the default strategy (a case-insensitive "contains" over the
// declared fields, LIKE wildcards taken literally, tiered fields searched
// only for readers who receive them), `minLength`, scopes (a column and a
// `via` junction), keyset paging in the scope collection's order, the
// `where` and `ids` strategies, the cancel check between an `ids` lookup and
// its read, and the statements each costs. Access is in `access.test.ts`.

import { describe, expect, it, vi } from "vitest";
import { consoleLogger } from "../../../index";
import { createContext } from "../../context";
import { cursorAfter } from "../crud/page";
import { addTasks, as, CARD_KEYS, idsOf, searchApp } from "./__tests__/fixture";
import { searchHandler } from "./run";

const kit = searchApp();

/** Tasks of `projectId`, one per title, ordinals 1, 2, ...; their ids in that order. */
async function addTitled(projectId: string, titles: readonly string[]): Promise<string[]> {
  const prisma = kit.harness().prisma;
  const ids: string[] = [];
  for (const [index, title] of titles.entries()) {
    const task = await prisma.task.create({ data: { projectId, title, ordinal: index + 1 } });
    ids.push(task.id);
  }
  return ids;
}

describe("the default strategy", () => {
  it("finds a match in each declared field, ignoring case, but not in a field the reader does not receive", async () => {
    const { app } = await kit.start();
    const board = kit.board();
    const [titled = "", noted = ""] = await addTitled(board.p1, ["Quarterly REPORT", "Budget"]);
    await kit.harness().prisma.task.update({
      where: { id: noted },
      data: { notes: "see the report draft" },
    });
    // A service-wide Admin grant receives the Admin-only notes, so they are searched.
    const admin = app.as(as(board.ed, { taskService: "Admin" })).taskService;
    const found = await admin.search({ q: "Report" });
    expect(idsOf(found)).toEqual([titled, noted]);
    expect(Object.keys(found.items[0] ?? {})).toEqual(CARD_KEYS);
    expect(found).toEqual({ items: expect.any(Array), nextCursor: null });
    // The owner's page is read at Read, which does not receive notes: a match there would tell.
    expect(idsOf(await app.as(as(board.ada)).taskService.search({ q: "report" }))).toEqual([
      titled,
    ]);
  });

  it("takes LIKE's wildcards and escape character literally", async () => {
    const { app } = await kit.start();
    const board = kit.board();
    const [percent, , underscore, , slash] = await addTitled(board.p1, [
      "50% off",
      "500 done",
      "a_b",
      "axb",
      "back\\slash",
    ]);
    const owner = app.as(as(board.ada)).taskService;
    expect(idsOf(await owner.search({ q: "0%" }))).toEqual([percent]);
    expect(idsOf(await owner.search({ q: "a_b" }))).toEqual([underscore]);
    expect(idsOf(await owner.search({ q: "k\\s" }))).toEqual([slash]);
  });

  it("finds nothing for a query shorter than minLength, once trimmed, and reads nothing", async () => {
    const { app } = await kit.start();
    const board = kit.board();
    const owner = app.as(as(board.ada)).taskService;
    const short = await kit.harness().storage.countStatements(() => owner.search({ q: "  T  " }));
    expect(short).toEqual({ value: { items: [], nextCursor: null }, statements: 0 });
    expect(idsOf(await owner.search({ q: "  t1 " }))).toEqual([board.t1]);
    // searchByLabel declares minLength 1.
    const label = await kit.harness().prisma.label.create({
      data: { projectId: board.p1, name: "L" },
    });
    await kit.harness().prisma.taskLabel.create({ data: { taskId: board.t1, labelId: label.id } });
    expect(idsOf(await owner.searchByLabel({ q: "1", scope: label.id }))).toEqual([board.t1]);
  });
});

describe("a scope", () => {
  it("keeps to its members, and marks the page as the collection's items", async () => {
    const { app } = await kit.start();
    const board = kit.board();
    const [inP1 = ""] = await addTitled(board.p1, ["Plan the launch"]);
    const [inP2 = ""] = await addTitled(board.p2, ["Plan the party"]);
    const admin = app.as(as(board.cy, { taskService: "Admin" })).taskService;
    expect(idsOf(await admin.search({ q: "plan" })).sort()).toEqual([inP1, inP2].sort());
    const scoped = await admin.search({ q: "plan", scope: board.p1 });
    expect(scoped).toEqual({
      items: [expect.objectContaining({ id: inP1 })],
      nextCursor: null,
      rev: expect.any(Number),
    });
    // Without a scope the results are not one collection's items: no revision.
    expect(await admin.search({ q: "plan" })).not.toHaveProperty("rev");
    expect(idsOf(await admin.search({ q: "plan", scope: board.p2 }))).toEqual([inP2]);
    // A scope cannot reach past the access filter: Cy reads P1 only.
    const reader = app.as(as(board.cy)).taskService;
    expect(idsOf(await reader.search({ q: "plan", scope: board.p2 }))).toEqual([]);
    expect(idsOf(await reader.search({ q: "plan", scope: "no-such-project" }))).toEqual([]);
  });

  it("of a via collection keeps to the rows its junction links to the scope", async () => {
    const { app } = await kit.start();
    const board = kit.board();
    const prisma = kit.harness().prisma;
    const [linked = "", unlinked = "", other = ""] = await addTitled(board.p1, [
      "Fix login",
      "Fix logout",
      "Fix signup",
    ]);
    const label = await prisma.label.create({ data: { projectId: board.p1, name: "Bug" } });
    const empty = await prisma.label.create({ data: { projectId: board.p1, name: "None" } });
    await prisma.taskLabel.createMany({
      data: [
        { taskId: linked, labelId: label.id },
        { taskId: other, labelId: label.id },
      ],
    });
    const owner = app.as(as(board.ada)).taskService;
    expect(idsOf(await owner.searchByLabel({ q: "fix", scope: label.id })).sort()).toEqual(
      [linked, other].sort(),
    );
    expect(idsOf(await owner.searchByLabel({ q: "log", scope: label.id }))).toEqual([linked]);
    expect(unlinked).not.toBe("");
    // A scope without links has no members: the junction is read, the rows are not.
    const admin = app.as(as(board.cy, { taskService: "Admin" })).taskService;
    const counted = await kit
      .harness()
      .storage.countStatements(() => admin.searchByLabel({ q: "fix", scope: empty.id }));
    expect(counted).toEqual({ value: { items: [], nextCursor: null }, statements: 1 });
  });
});

describe("paging", () => {
  it("pages by keyset cursor in the scope collection's order", async () => {
    const { app } = await kit.start();
    const board = kit.board();
    const ids = await addTitled(board.p1, ["Match 1", "Match 2", "Other", "Match 3", "Match 4"]);
    const owner = app.as(as(board.ada)).taskService;
    const seen: string[] = [];
    const cursors: (string | null)[] = [];
    let cursor: string | undefined;
    do {
      const page = await owner.search({ q: "match", scope: board.p1, limit: 2, cursor });
      seen.push(...idsOf(page));
      cursors.push(page.nextCursor);
      cursor = page.nextCursor ?? undefined;
    } while (cursor !== undefined);
    expect(seen).toEqual([ids[0], ids[1], ids[3], ids[4]]);
    expect(cursors).toEqual([expect.any(String), null]);
  });

  it("returns 20 results by default and at most 100, and refuses a crafted cursor", async () => {
    const { app } = await kit.start();
    const board = kit.board();
    await kit.harness().prisma.task.createMany({
      data: Array.from({ length: 105 }, (_, index) => ({
        projectId: board.p1,
        title: `Bulk ${index}`,
        ordinal: index + 1,
      })),
    });
    const owner = app.as(as(board.ada)).taskService;
    expect((await owner.search({ q: "bulk" })).items).toHaveLength(20);
    const clamped = await owner.search({ q: "bulk", limit: 1000 });
    expect(clamped.items).toHaveLength(100);
    expect(clamped.nextCursor).not.toBeNull();
    const crafted = [
      "not a cursor",
      cursorAfter([["id", "asc"]], { id: board.t1 }),
      cursorAfter(
        [
          ["ordinal", "asc"],
          ["id", "asc"],
        ],
        { ordinal: "first", id: board.t1 },
      ),
    ];
    for (const cursor of crafted) {
      await expect(owner.search({ q: "bulk", cursor })).rejects.toMatchObject({
        code: "VALIDATION",
      });
    }
  });

  it("refuses an input it does not know", async () => {
    const { app } = await kit.start();
    const owner = app.as(as(kit.board().ada)).taskService as unknown as {
      search(input: unknown): Promise<unknown>;
      searchByLabel(input: unknown): Promise<unknown>;
    };
    await expect(owner.search({ q: 5 })).rejects.toMatchObject({
      code: "VALIDATION",
      data: { issues: [{ path: ["q"] }] },
    });
    await expect(owner.search({ q: "x".repeat(257) })).rejects.toMatchObject({
      code: "VALIDATION",
    });
    await expect(owner.search({ q: "ab", where: { id: "x" } })).rejects.toMatchObject({
      code: "VALIDATION",
      data: { issues: [{ path: ["where"] }] },
    });
    await expect(owner.search({ q: "ab", limit: 0 })).rejects.toMatchObject({
      code: "VALIDATION",
    });
    await expect(owner.search({ q: "ab", scope: "" })).rejects.toMatchObject({
      code: "VALIDATION",
      data: { issues: [{ path: ["scope"] }] },
    });
  });
});

describe("strategies", () => {
  it("honors a where strategy, inside the access filter and the scope", async () => {
    const where = vi.fn((q: string) => ({ status: q }));
    const { app } = await kit.start({ strategy: { where } });
    const board = kit.board();
    const prisma = kit.harness().prisma;
    const [done = ""] = await addTasks(prisma, board.p1, [1], { status: "done" });
    const [elsewhere = ""] = await addTasks(prisma, board.p2, [1], { status: "done" });
    const reader = app.as(as(board.cy)).taskService;
    expect(idsOf(await reader.search({ q: "done" }))).toEqual([done]);
    expect(where).toHaveBeenCalledWith("done", expect.objectContaining({ transport: "internal" }));
    const admin = app.as(as(board.cy, { taskService: "Admin" })).taskService;
    expect(idsOf(await admin.search({ q: "done", scope: board.p2 }))).toEqual([elsewhere]);
  });

  it("honors an ids strategy's order, and still keeps only the rows the caller may read", async () => {
    const ranked: string[] = [];
    const ids = vi.fn((_q: string, _ctx: unknown, options: { readonly limit: number }) =>
      ranked.slice(0, options.limit + 1),
    );
    const { app } = await kit.start({ strategy: { ids } });
    const board = kit.board();
    const [mine = ""] = await addTasks(kit.harness().prisma, board.p1, [5]);
    ranked.push(board.t2, mine, "missing", board.t1, mine);
    // Cy reads P1 only: T2 is left out, as is the id with no row.
    const reader = app.as(as(board.cy)).taskService;
    expect(await reader.search({ q: "anything" })).toEqual({
      items: [expect.objectContaining({ id: mine }), expect.objectContaining({ id: board.t1 })],
      nextCursor: null,
    });
    expect(ids).toHaveBeenLastCalledWith("anything", expect.anything(), { limit: 20 });
    expect(idsOf(await app.as(as(board.ed)).taskService.search({ q: "anything" }))).toEqual([
      board.t2,
    ]);
    // At most `limit` of them, before the access filter; the scope applies too.
    const admin = app.as(as(board.cy, { taskService: "Admin" })).taskService;
    expect(idsOf(await admin.search({ q: "anything", limit: 2 }))).toEqual([board.t2, mine]);
    expect(idsOf(await admin.search({ q: "anything", scope: board.p1 }))).toEqual([mine, board.t1]);
    // One page: there is no cursor to pass.
    await expect(admin.search({ q: "anything", cursor: "abc" })).rejects.toMatchObject({
      code: "VALIDATION",
      data: { issues: [{ path: ["cursor"] }] },
    });
  });

  it("fails INTERNAL when a strategy returns something else", async () => {
    const { app } = await kit.start({ strategy: { ids: () => [7] as unknown as string[] } });
    const owner = app.as(as(kit.board().ada)).taskService;
    await expect(owner.search({ q: "anything" })).rejects.toMatchObject({ code: "INTERNAL" });
    const where = await kit.start({
      strategy: { where: () => "title" as unknown as Record<string, unknown> },
    });
    await expect(
      where.app.as(as(kit.board().ada)).taskService.search({ q: "anything" }),
    ).rejects.toMatchObject({ code: "INTERNAL" });
  });

  it("stops between an ids lookup and the read when the caller cancelled meanwhile", async () => {
    const { app, service } = await kit.start();
    const board = kit.board();
    const controller = new AbortController();
    const findMany = vi.fn();
    const handler = searchHandler({
      spec: { fields: ["title"], item: undefined, scope: undefined, minLength: 2 },
      form: "authenticated",
      projection: "entity",
      strategy: {
        ids: () => {
          controller.abort();
          return [board.t1];
        },
      },
    });
    const ctx = createContext({
      principal: as(board.ada),
      signal: controller.signal,
      log: consoleLogger,
      requestId: "r1",
      transport: "internal",
      kit: { service, access: app.server.dispatcher.access, storage: kit.harness().storage },
    });
    const db = { task: { findMany } };
    await expect(
      handler({ input: { q: "task", limit: 20 }, ctx, db: db as unknown }),
    ).rejects.toMatchObject({ code: "CANCELLED" });
    expect(findMany).not.toHaveBeenCalled();
  });
});

describe("statements", () => {
  it("costs one statement with a service-wide Admin grant, and the access filter's reads under inherit", async () => {
    const { app } = await kit.start();
    const board = kit.board();
    const { storage } = kit.harness();
    await addTitled(board.p1, ["Match 1", "Match 2"]);
    const count = async (call: () => Promise<unknown>) =>
      (await storage.countStatements(call)).statements;
    const admin = app.as(as(board.ed, { taskService: "Admin" })).taskService;
    const owner = app.as(as(board.ada)).taskService;
    // Warm up: the storage adapter asks once per process whether an order column may hold null.
    await admin.search({ q: "match" });
    expect(await count(() => admin.search({ q: "match" }))).toBe(1);
    expect(await count(() => admin.search({ q: "match", scope: board.p1 }))).toBe(1);
    // The task policy inherits the project's: the filter reads the projects the owner may
    // read (members, then the projects), then the page.
    expect(await count(() => owner.search({ q: "match", scope: board.p1 }))).toBe(3);
  });
});
