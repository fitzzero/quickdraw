// @vitest-environment node
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  buildPgliteTemplate,
  computeMigrationsFingerprint,
  pgliteTemplatePaths,
  readMigrationSql,
  resetDatabase,
  workerDatabaseUrl,
} from "./testing-prisma";

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
    expect(before.rows[0].count).toBe(1);

    const client = {
      $executeRawUnsafe: async (sql: string): Promise<unknown> => pglite.exec(sql),
    };
    await resetDatabase(client);

    const after = await pglite.query<{ count: number }>(
      `SELECT count(*)::int AS count FROM "User"`,
    );
    expect(after.rows[0].count).toBe(0);

    await pglite.close();
  }, 60_000);
});
