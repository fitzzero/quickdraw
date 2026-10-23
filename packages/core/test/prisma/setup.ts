// The database core's Prisma tests run against: an in-memory PGlite
// database with test/prisma/migrations applied (read with `readMigrationSql`
// from src/testing/prisma.ts), and the client generated from
// test/prisma/schema.prisma on the pglite-prisma-adapter driver adapter.
// PGlite runs in the test process, so a test file needs no PostgreSQL
// server and shares nothing with other files.
//
// That adapter's transactions have no savepoints, so Prisma refuses a
// nested transaction (`tx.$transaction(...)`) on it. `SavepointPGlite`
// gives them the three methods `@prisma/adapter-pg` has, with the same SQL,
// which PGlite, a PostgreSQL, runs as any PostgreSQL does.

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

/** The SQL `@prisma/adapter-pg` runs for each savepoint method, the name given by Prisma. */
const SAVEPOINT_SQL = {
  createSavepoint: (name: string) => `SAVEPOINT ${name}`,
  rollbackToSavepoint: (name: string) => `ROLLBACK TO SAVEPOINT ${name}`,
  releaseSavepoint: (name: string) => `RELEASE SAVEPOINT ${name}`,
} as const;

/** What the PGlite adapter's factory connects to: Prisma's `SqlDriverAdapter`. */
type DriverAdapter = Awaited<ReturnType<PrismaPGlite["connect"]>>;

/** The PGlite adapter, its transactions given the savepoints of `@prisma/adapter-pg`. */
class SavepointPGlite extends PrismaPGlite {
  override async connect(): Promise<DriverAdapter> {
    const adapter = await super.connect();
    const start = adapter.startTransaction.bind(adapter);
    adapter.startTransaction = async (isolationLevel) => {
      const transaction = await start(isolationLevel);
      const run = async (sql: string): Promise<void> => {
        await transaction.executeRaw({ sql, args: [], argTypes: [] });
      };
      return Object.assign(transaction, {
        createSavepoint: (name: string) => run(SAVEPOINT_SQL.createSavepoint(name)),
        rollbackToSavepoint: (name: string) => run(SAVEPOINT_SQL.rollbackToSavepoint(name)),
        releaseSavepoint: (name: string) => run(SAVEPOINT_SQL.releaseSavepoint(name)),
      });
    };
    return adapter;
  }
}

/** Boots an in-memory PGlite database with the test schema's migrations applied. */
export async function createTestDatabase(): Promise<TestDatabase> {
  const pglite = new PGlite();
  await pglite.waitReady;
  for (const sql of readMigrationSql(migrationsDir)) {
    await pglite.exec(sql);
  }
  const prisma = new PrismaClient({ adapter: new SavepointPGlite(pglite) });
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
