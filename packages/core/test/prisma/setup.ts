// The database core's Prisma tests run against: an in-memory PGlite
// database with test/prisma/migrations applied (read with `readMigrationSql`
// from src/testing/prisma.ts), and the client generated from
// test/prisma/schema.prisma on the pglite-prisma-adapter driver adapter.
// PGlite runs in the test process, so a test file needs no PostgreSQL
// server and shares nothing with other files.
//
// That adapter's transactions have no savepoints, so Prisma refuses a
// nested transaction (`tx.$transaction(...)`) on it: `withSavepoints`, from
// `./testing/prisma` as apps get it, gives them the three methods
// `@prisma/adapter-pg` has, with the same SQL.
//
// `createPostgresTestDatabase` is the same schema on a real PostgreSQL, for
// the tests gated on QD_PG_URL: a database of its own on that server,
// migrated, and dropped again on `close()`.

import { randomUUID } from "node:crypto";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { PGlite } from "@electric-sql/pglite";
import { PrismaPGlite } from "pglite-prisma-adapter";
import { readMigrationSql, resetDatabase, withSavepoints } from "../../src/testing/prisma";
import { PrismaClient } from "./generated/client";

export { PrismaClient } from "./generated/client";

const migrationsDir = resolve(dirname(fileURLToPath(import.meta.url)), "migrations");

/** A migrated test database and an untracked client on it. */
export interface TestDatabase {
  /** An untracked client, for setup and assertions. */
  readonly prisma: PrismaClient;
  readonly pglite: PGlite;
  /** Empties every table. */
  reset(): Promise<void>;
  close(): Promise<void>;
}

/** Boots an in-memory PGlite database with the test schema's migrations applied. */
export async function createTestDatabase(): Promise<TestDatabase> {
  const pglite = new PGlite();
  await pglite.waitReady;
  for (const sql of readMigrationSql(migrationsDir)) {
    await pglite.exec(sql);
  }
  const prisma = new PrismaClient({ adapter: withSavepoints(new PrismaPGlite(pglite)) });
  return {
    prisma,
    pglite,
    reset: () => resetDatabase(prisma),
    async close() {
      await prisma.$disconnect();
      await pglite.close();
    },
  };
}

/** The test schema on a real PostgreSQL, and an untracked client on it. */
export interface PostgresTestDatabase {
  readonly prisma: PrismaClient;
  /** Empties every table. */
  reset(): Promise<void>;
  /** Disconnects, and drops the database. */
  close(): Promise<void>;
}

/**
 * A database of its own on the PostgreSQL server `serverUrl` names (a
 * throwaway one: QD_PG_URL), with the test schema's migrations applied, on
 * `@prisma/adapter-pg`. `close()` drops it again.
 */
export async function createPostgresTestDatabase(serverUrl: string): Promise<PostgresTestDatabase> {
  const { default: pg } = await import("pg");
  const name = `qd_test_${randomUUID().replaceAll("-", "")}`;
  const on = (database: string | undefined): string => {
    const url = new URL(serverUrl);
    if (database !== undefined) {
      url.pathname = `/${database}`;
    }
    return url.toString();
  };
  const run = async (url: string, statements: readonly string[]): Promise<void> => {
    const client = new pg.Client({ connectionString: url });
    await client.connect();
    try {
      for (const statement of statements) {
        await client.query(statement);
      }
    } finally {
      await client.end();
    }
  };
  await run(on(undefined), [`CREATE DATABASE "${name}"`]);
  await run(on(name), readMigrationSql(migrationsDir));
  const { PrismaPg } = await import("@prisma/adapter-pg");
  const prisma = new PrismaClient({ adapter: new PrismaPg({ connectionString: on(name) }) });
  return {
    prisma,
    reset: () => resetDatabase(prisma),
    async close() {
      await prisma.$disconnect();
      await run(on(undefined), [`DROP DATABASE IF EXISTS "${name}" WITH (FORCE)`]);
    },
  };
}
