// The database core's Prisma tests run against: an in-memory PGlite
// database with test/prisma/migrations applied (read with `readMigrationSql`
// from src/testing/prisma.ts), and the client generated from
// test/prisma/schema.prisma on the pglite-prisma-adapter driver adapter.
// PGlite runs in the test process, so a test file needs no PostgreSQL
// server and shares nothing with other files.

import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { PGlite } from "@electric-sql/pglite";
import { PrismaPGlite } from "pglite-prisma-adapter";
import { readMigrationSql, resetDatabase } from "../../src/testing/prisma";
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
  const prisma = new PrismaClient({ adapter: new PrismaPGlite(pglite) });
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
