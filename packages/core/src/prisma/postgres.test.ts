// The tracked client on a real PostgreSQL, for what PGlite, which has one
// connection, cannot show: work on another connection while a transaction is
// open (RFC 0003 section 5.2). A transaction's client writes to that
// transaction wherever it runs, the root client's work runs outside every
// transaction, and a stale client is refused, as Prisma has them.
//
// Skipped unless QD_PG_URL names a PostgreSQL server the test may create a
// database on (a throwaway container, never one holding data): it creates a
// database of its own there, applies the test schema's migration, and drops
// it again.
//
//   docker run -d --name qd-pg -e POSTGRES_PASSWORD=pg -p 127.0.0.1:5440:5432 postgres:16-alpine
//   QD_PG_URL=postgresql://postgres:pg@127.0.0.1:5440/postgres bunx vitest run src/prisma/postgres.test.ts

import { randomUUID } from "node:crypto";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { PrismaClient } from "../../test/prisma/generated/client";
import { storageOf } from "../server/storage";
import type { WriteRecord } from "../server/uow/types";
import { readMigrationSql, resetDatabase } from "../testing/prisma";
import { createRecordingSink } from "../testing/recordingSink";
import type { Tracked } from "./tracked";
import { trackPrisma } from "./trackPrisma";

const SERVER = process.env.QD_PG_URL;
const MIGRATIONS = resolve(dirname(fileURLToPath(import.meta.url)), "../../test/prisma/migrations");
const UNDONE = "roll the transaction back";

describe.skipIf(SERVER === undefined)("the tracked client on PostgreSQL (QD_PG_URL)", () => {
  const name = `qd_test_${randomUUID().replaceAll("-", "")}`;
  let prisma: PrismaClient;
  let db: Tracked<PrismaClient>;
  let projectId = "";

  /** Runs `sql` on the server, or on the test's own database with `own`. */
  async function admin(sql: readonly string[], own = false): Promise<void> {
    const { default: pg } = await import("pg");
    const url = new URL(SERVER ?? "");
    if (own) {
      url.pathname = `/${name}`;
    }
    const client = new pg.Client({ connectionString: url.toString() });
    await client.connect();
    try {
      for (const statement of sql) {
        await client.query(statement);
      }
    } finally {
      await client.end();
    }
  }

  beforeAll(async () => {
    await admin([`CREATE DATABASE "${name}"`]);
    await admin(readMigrationSql(MIGRATIONS), true);
    const { PrismaPg } = await import("@prisma/adapter-pg");
    const url = new URL(SERVER ?? "");
    url.pathname = `/${name}`;
    prisma = new PrismaClient({ adapter: new PrismaPg({ connectionString: url.toString() }) });
    db = trackPrisma(prisma, {
      interest: { task: ["projectId", "status"] },
      development: false,
    });
  }, 60_000);

  afterAll(async () => {
    await prisma.$disconnect();
    await admin([`DROP DATABASE IF EXISTS "${name}" WITH (FORCE)`]);
  });

  beforeEach(async () => {
    await resetDatabase(prisma);
    const user = await prisma.user.create({ data: { email: "ada@example.com", name: "Ada" } });
    projectId = (await prisma.project.create({ data: { name: "Board", ownerId: user.id } })).id;
  });

  /** Runs `fn` in a unit of work of the tracked client, flushes it, and gives what it flushed as `op id`. */
  async function flushed(fn: () => Promise<unknown>): Promise<string[]> {
    const storage = storageOf(db);
    if (storage === undefined) {
      throw new Error("trackPrisma's client carries no storage adapter");
    }
    const sink = createRecordingSink();
    const unit = storage.unitOfWork.begin({ requestId: "test", transport: "internal", sink });
    await unit.run(fn).catch((error: unknown) => {
      if (!(error instanceof Error && error.message === UNDONE)) {
        throw error;
      }
    });
    await unit.flush();
    return sink.writes().map((write: WriteRecord) => `${write.op} ${write.id}`);
  }

  /** The tasks the database holds, as `id:status`. */
  async function rows(): Promise<string[]> {
    return (await prisma.task.findMany({ orderBy: { id: "asc" } })).map(
      (task) => `${task.id}:${task.status}`,
    );
  }

  it("flushes the root client's work inside a callback that rolls back, which commits on its own", async () => {
    await prisma.task.create({ data: { id: "old", projectId, title: "old" } });
    const writes = await flushed(() =>
      db.$transaction(async (tx) => {
        await tx.task.create({ data: { id: "a", projectId, title: "a" } });
        await db.task.create({ data: { id: "d", projectId, title: "d" } });
        await db.task.createMany({ data: [{ id: "e", projectId, title: "e" }] });
        await db.task.updateMany({ where: { id: "old" }, data: { status: "touched" } });
        await db.$transaction(async (own) => {
          await own.task.create({ data: { id: "t", projectId, title: "t" } });
        });
        throw new Error(UNDONE);
      }),
    );
    expect(await rows()).toEqual(["d:open", "e:open", "old:touched", "t:open"]);
    expect(writes).toEqual(["create d", "create e", "update old", "create t"]);
  });

  it("reads a root deleteMany's rows on the root client, which does not see the transaction's", async () => {
    await prisma.task.create({ data: { id: "old", projectId, title: "old" } });
    const writes = await flushed(() =>
      db.$transaction(async (tx) => {
        await tx.task.create({ data: { id: "a", projectId, title: "a" } });
        await db.task.deleteMany({ where: { id: { in: ["a", "old"] } } });
      }),
    );
    expect(await rows()).toEqual(["a:open"]);
    expect(writes).toEqual(["delete old", "create a"]);
  });

  it("runs the outer transaction's client in the outer transaction, inside another's callback", async () => {
    await prisma.task.create({ data: { id: "old", projectId, title: "old" } });
    const writes = await flushed(() =>
      db.$transaction(async (tx) => {
        await db.$transaction(async (own) => {
          await own.task.create({ data: { id: "own", projectId, title: "own" } });
          await tx.task.create({ data: { id: "outer", projectId, title: "outer" } });
          await tx.task.update({ where: { id: "old" }, data: { status: "outer" } });
          await tx.task.createMany({ data: [{ id: "outer many", projectId, title: "m" }] });
        });
        throw new Error(UNDONE);
      }),
    );
    // As on the untracked client: the outer's writes rolled back with it, the inner's stayed.
    expect(await rows()).toEqual(["old:open", "own:open"]);
    expect(writes).toEqual(["create own"]);
  });

  it("puts a transaction client's operation in an array-form batch into its own transaction", async () => {
    const writes = await flushed(() =>
      db.$transaction(async (tx) => {
        await db.$transaction([tx.task.create({ data: { id: "x", projectId, title: "x" } })]);
        throw new Error(UNDONE);
      }),
    );
    expect(await rows()).toEqual([]);
    expect(writes).toEqual([]);
  });

  it("flushes the root client's operation in a transaction's nested array-form batch", async () => {
    const writes = await flushed(() =>
      db.$transaction(async (tx) => {
        await tx.$transaction([db.task.create({ data: { id: "r", projectId, title: "r" } })]);
        throw new Error(UNDONE);
      }),
    );
    expect(await rows()).toEqual(["r:open"]);
    expect(writes).toEqual(["create r"]);
  });

  it("refuses a stale transaction client's writes, as the untracked client does", async () => {
    await prisma.task.create({ data: { id: "old", projectId, title: "old" } });
    let stale: Parameters<Parameters<typeof db.$transaction>[0]>[0] | undefined;
    await db.$transaction(async (tx) => {
      stale = tx;
    });
    const writes = await flushed(async () => {
      await expect(
        stale?.task.createMany({ data: [{ id: "s", projectId, title: "s" }] }),
      ).rejects.toThrow();
      await expect(
        stale?.task.updateMany({ where: { id: "old" }, data: { status: "stale" } }),
      ).rejects.toThrow();
      await expect(
        stale?.task.create({ data: { id: "c", projectId, title: "c" } }),
      ).rejects.toThrow();
    });
    expect(await rows()).toEqual(["old:open"]);
    expect(writes).toEqual([]);
  });
});
