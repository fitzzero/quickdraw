// @vitest-environment node
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { PrismaPGlite } from "pglite-prisma-adapter";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createPostgresTestDatabase, PrismaClient } from "../../test/prisma/setup";
import {
  buildPgliteTemplate,
  computeMigrationsFingerprint,
  openPgliteFromTemplate,
  pgliteTemplatePaths,
  readMigrationSql,
  resetDatabase,
  withSavepoints,
  workerDatabaseUrl,
  type SavepointTransaction,
} from "./prisma";

const MIGRATION_SQL = `CREATE TABLE "User" (id TEXT PRIMARY KEY, email TEXT NOT NULL);`;
const SECOND_MIGRATION_SQL = `ALTER TABLE "User" ADD COLUMN name TEXT;`;

describe("workerDatabaseUrl", () => {
  it("rewrites the database segment", () => {
    expect(workerDatabaseUrl("postgresql://dev:dev@localhost:5432/app_test", "3")).toBe(
      "postgresql://dev:dev@localhost:5432/test_worker_3",
    );
  });

  it("preserves query strings and custom prefixes", () => {
    expect(
      workerDatabaseUrl("postgresql://dev:dev@localhost:5432/app_test?schema=public", "1", "w_"),
    ).toBe("postgresql://dev:dev@localhost:5432/w_1?schema=public");
  });
});

describe("PGlite template machinery", () => {
  let workDir: string;
  let migrationsDir: string;
  let cacheDir: string;

  beforeAll(() => {
    workDir = mkdtempSync(join(tmpdir(), "quickdraw-testing-prisma-"));
    migrationsDir = join(workDir, "migrations");
    cacheDir = join(workDir, "cache");
    mkdirSync(join(migrationsDir, "0001_init"), { recursive: true });
    writeFileSync(join(migrationsDir, "0001_init", "migration.sql"), MIGRATION_SQL);
  });

  afterAll(() => {
    rmSync(workDir, { recursive: true, force: true });
  });

  it("reads migrations in order and fingerprints their content", () => {
    expect(readMigrationSql(migrationsDir)).toEqual([MIGRATION_SQL]);

    const before = computeMigrationsFingerprint(migrationsDir);
    expect(before).toBe(computeMigrationsFingerprint(migrationsDir));

    mkdirSync(join(migrationsDir, "0002_add_name"), { recursive: true });
    writeFileSync(join(migrationsDir, "0002_add_name", "migration.sql"), SECOND_MIGRATION_SQL);
    expect(computeMigrationsFingerprint(migrationsDir)).not.toBe(before);
    expect(readMigrationSql(migrationsDir)).toEqual([MIGRATION_SQL, SECOND_MIGRATION_SQL]);
  });

  it("builds a loadable template dump, caches by fingerprint, and resets data", async () => {
    const options = { migrationsDir, cacheDir, templateName: "test-template" };

    const first = await buildPgliteTemplate(options);
    expect(first.rebuilt).toBe(true);

    const second = await buildPgliteTemplate(options);
    expect(second.rebuilt).toBe(false);
    expect(second.templatePath).toBe(first.templatePath);
    expect(pgliteTemplatePaths(options).templatePath).toBe(first.templatePath);

    // Boot a fresh PGlite from the dump and verify schema + resetDatabase.
    const { PGlite } = await import("@electric-sql/pglite");
    const blob = new Blob([readFileSync(first.templatePath)], { type: "application/x-gzip" });
    const pglite = new PGlite({ loadDataDir: blob });
    await pglite.waitReady;

    await pglite.exec(`INSERT INTO "User" (id, email, name) VALUES ('1', 'a@b.c', 'A')`);
    const before = await pglite.query<{ count: number }>(
      `SELECT count(*)::int AS count FROM "User"`,
    );
    expect(before.rows[0]?.count).toBe(1);

    const client = {
      $executeRawUnsafe: async (sql: string): Promise<unknown> => pglite.exec(sql),
    };
    await resetDatabase(client);

    const after = await pglite.query<{ count: number }>(
      `SELECT count(*)::int AS count FROM "User"`,
    );
    expect(after.rows[0]?.count).toBe(0);

    await pglite.close();
  }, 60_000);

  it("opens a worker's database from the template, building it when missing", async () => {
    const options = { migrationsDir, cacheDir: join(workDir, "fresh"), templateName: "worker" };
    const first = await openPgliteFromTemplate(options);
    await first.exec(`INSERT INTO "User" (id, email, name) VALUES ('1', 'a@b.c', 'A')`);
    // A second worker boots its own copy: what one writes the other never sees.
    const second = await openPgliteFromTemplate(options);
    const rows = await second.query<{ count: number }>(`SELECT count(*)::int AS count FROM "User"`);
    expect(rows.rows[0]?.count).toBe(0);
    await Promise.all([first.close(), second.close()]);
  }, 60_000);
});

describe("withSavepoints", () => {
  /** A driver adapter factory whose transactions record the SQL they run, with savepoints of their own or none. */
  function fakeFactory(own: boolean) {
    const ran: string[] = [];
    const transaction: SavepointTransaction = {
      executeRaw: async (query) => {
        ran.push(query.sql);
        return 0;
      },
      ...(own
        ? {
            createSavepoint: async (name: string) => {
              ran.push(`own ${name}`);
            },
          }
        : {}),
    };
    const factory = {
      provider: "postgres" as const,
      adapterName: "fake",
      connect: async () => ({
        name: "adapter",
        startTransaction: async (isolationLevel?: never) => {
          ran.push(`begin ${String(isolationLevel)}`);
          return transaction;
        },
      }),
      connectToShadowDb() {
        return this.adapterName;
      },
    };
    return { factory, ran };
  }

  it("gives an adapter's transactions the savepoints of @prisma/adapter-pg, and keeps the rest", async () => {
    const { factory, ran } = fakeFactory(false);
    const wrapped = withSavepoints(factory);
    expect(wrapped.provider).toBe("postgres");
    expect(wrapped.connectToShadowDb()).toBe("fake");
    const adapter = await wrapped.connect();
    expect(adapter.name).toBe("adapter");
    const transaction = await adapter.startTransaction();
    await transaction.createSavepoint?.("prisma_sp_0");
    await transaction.rollbackToSavepoint?.("prisma_sp_0");
    await transaction.releaseSavepoint?.("prisma_sp_0");
    expect(ran).toEqual([
      "begin undefined",
      "SAVEPOINT prisma_sp_0",
      "ROLLBACK TO SAVEPOINT prisma_sp_0",
      "RELEASE SAVEPOINT prisma_sp_0",
    ]);
  });

  it("leaves an adapter with savepoints of its own as it is", async () => {
    const { factory, ran } = fakeFactory(true);
    const transaction = await (await withSavepoints(factory).connect()).startTransaction();
    await transaction.createSavepoint?.("prisma_sp_0");
    expect(transaction.releaseSavepoint).toBeUndefined();
    expect(ran).toEqual(["begin undefined", "own prisma_sp_0"]);
  });
});

/**
 * What nested transactions leave in the database: a savepoint rolled back
 * while the transaction around it commits, one released before it commits,
 * and one released before it rolls back, each from an empty table.
 */
async function nestedOutcomes(prisma: PrismaClient): Promise<string[][]> {
  const user = await prisma.user.create({ data: { email: "ada@example.com", name: "Ada" } });
  const { id: projectId } = await prisma.project.create({
    data: { name: "Board", ownerId: user.id },
  });
  const task = (id: string) => ({ data: { id, projectId, title: id } });
  const tasks = async (): Promise<string[]> => {
    const rows = await prisma.task.findMany({ orderBy: { id: "asc" } });
    await prisma.task.deleteMany();
    return rows.map((row) => row.id);
  };
  const outcomes: string[][] = [];
  await prisma.$transaction(async (tx) => {
    await tx.task.create(task("a"));
    await tx
      .$transaction(async (inner) => {
        await inner.task.create(task("b"));
        throw new Error("roll the savepoint back");
      })
      .catch(() => undefined);
  });
  outcomes.push(await tasks());
  await prisma.$transaction(async (tx) => {
    await tx.task.create(task("a"));
    await tx.$transaction(async (inner) => {
      await inner.task.create(task("b"));
    });
  });
  outcomes.push(await tasks());
  await prisma
    .$transaction(async (tx) => {
      await tx.task.create(task("a"));
      await tx.$transaction(async (inner) => {
        await inner.task.create(task("b"));
      });
      throw new Error("roll everything back");
    })
    .catch(() => undefined);
  outcomes.push(await tasks());
  return outcomes;
}

describe("a nested transaction on a worker's PGlite database", () => {
  const migrationsDir = resolve(
    dirname(fileURLToPath(import.meta.url)),
    "../../test/prisma/migrations",
  );
  let cacheDir: string;

  beforeAll(() => {
    cacheDir = mkdtempSync(join(tmpdir(), "quickdraw-testing-savepoints-"));
  });

  afterAll(() => {
    rmSync(cacheDir, { recursive: true, force: true });
  });

  it("commits and rolls back as on PostgreSQL, through withSavepoints", async () => {
    const pglite = await openPgliteFromTemplate({
      migrationsDir,
      cacheDir,
      templateName: "savepoints",
    });
    const prisma = new PrismaClient({ adapter: withSavepoints(new PrismaPGlite(pglite)) });
    try {
      expect(await nestedOutcomes(prisma)).toEqual([["a"], ["a", "b"], []]);
    } finally {
      await prisma.$disconnect();
      await pglite.close();
    }
  }, 60_000);

  it("is refused without it, as pglite-prisma-adapter has no savepoints", async () => {
    const pglite = await openPgliteFromTemplate({
      migrationsDir,
      cacheDir,
      templateName: "savepoints",
    });
    const prisma = new PrismaClient({ adapter: new PrismaPGlite(pglite) });
    try {
      await expect(
        prisma.$transaction(async (tx) => await tx.$transaction(async () => undefined)),
      ).rejects.toThrow("createSavepoint is not implemented");
    } finally {
      await prisma.$disconnect();
      await pglite.close();
    }
  }, 60_000);

  it.skipIf(process.env.QD_PG_URL === undefined)(
    "leaves what PostgreSQL leaves (QD_PG_URL)",
    async () => {
      const database = await createPostgresTestDatabase(process.env.QD_PG_URL ?? "");
      try {
        expect(await nestedOutcomes(database.prisma)).toEqual([["a"], ["a", "b"], []]);
      } finally {
        await database.close();
      }
    },
    60_000,
  );
});
