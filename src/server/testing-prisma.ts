/**
 * Prisma test-database helpers (dual-mode: real PostgreSQL or PGlite).
 *
 * Exported as `@fitzzero/quickdraw-core/server/testing/prisma`.
 *
 * Real-PostgreSQL mode: a template database is migrated once per run, then
 * per-worker databases are cloned from it (`CREATE DATABASE … TEMPLATE …`) so
 * vitest workers never share state. PGlite mode (no TEST_DATABASE_URL):
 * migrations run once into an in-memory PGlite instance whose data dir is
 * dumped to a gzip cache keyed by a migrations fingerprint — later test
 * processes boot from the dump in milliseconds with no PostgreSQL at all.
 *
 * `pg` and `@electric-sql/pglite` are optional peers, loaded via dynamic
 * import only inside the mode that needs them. App-specific pieces (the
 * generated PrismaClient, adapter choice, seed helpers) stay in the app.
 */

import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";

export interface RawSqlClient {
  $executeRawUnsafe(sql: string): Promise<unknown>;
}

/**
 * Reset a test database by truncating all public tables.
 *
 * Dynamic TRUNCATE discovers all tables so it never falls out of sync with
 * schema changes. Retries on deadlock (surfaced by Prisma as P2010), which can
 * occur when parallel test files within the same fork race on TRUNCATE vs
 * active queries.
 */
export async function resetDatabase(client: RawSqlClient): Promise<void> {
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      await client.$executeRawUnsafe(`
        DO $$
        DECLARE _tables TEXT;
        BEGIN
          SELECT string_agg('"' || tablename || '"', ', ')
          INTO _tables
          FROM pg_tables
          WHERE schemaname = 'public' AND tablename != '_prisma_migrations';
          IF _tables IS NOT NULL THEN
            EXECUTE 'TRUNCATE TABLE ' || _tables || ' CASCADE';
          END IF;
        END $$
      `);
      return;
    } catch (error: unknown) {
      const isDeadlock =
        error instanceof Error && "code" in error && (error as { code: string }).code === "P2010";
      if (!isDeadlock || attempt === 2) throw error;
      await new Promise<void>((r) => {
        setTimeout(r, 50 * (attempt + 1));
      });
    }
  }
}

/**
 * Rewrite a database URL to point at a per-worker database
 * (e.g. ".../app_test" → ".../test_worker_3").
 */
export function workerDatabaseUrl(
  baseUrl: string,
  poolId: string,
  prefix: string = "test_worker_",
): string {
  return baseUrl.replace(/\/[^/?]+(\?|$)/, `/${prefix}${poolId}$1`);
}

/** Sorted migration directory names under a Prisma migrations dir. */
function migrationDirNames(migrationsDir: string): string[] {
  return readdirSync(migrationsDir, { withFileTypes: true })
    .filter((d) => d.isDirectory())
    .map((d) => d.name)
    .sort();
}

/**
 * Hash of all migration.sql contents — cache key for the PGlite template.
 */
export function computeMigrationsFingerprint(migrationsDir: string): string {
  const hash = createHash("sha256");
  for (const dir of migrationDirNames(migrationsDir)) {
    const sqlPath = resolve(migrationsDir, dir, "migration.sql");
    if (existsSync(sqlPath)) {
      hash.update(readFileSync(sqlPath));
    }
  }
  return hash.digest("hex");
}

/** All migration.sql contents in execution order. */
export function readMigrationSql(migrationsDir: string): string[] {
  const sqls: string[] = [];
  for (const dir of migrationDirNames(migrationsDir)) {
    const sqlPath = resolve(migrationsDir, dir, "migration.sql");
    if (existsSync(sqlPath)) {
      sqls.push(readFileSync(sqlPath, "utf-8"));
    }
  }
  return sqls;
}

export interface PgliteTemplateOptions {
  /** Absolute path to the Prisma migrations directory. */
  migrationsDir: string;
  /** Cache directory for the template dump (e.g. node_modules/.cache). */
  cacheDir: string;
  /** Base name for the cache files (e.g. "myapp-test-template"). */
  templateName: string;
}

export interface PgliteTemplatePaths {
  templatePath: string;
  fingerprintPath: string;
}

/** Resolve the cache file locations for a PGlite template. */
export function pgliteTemplatePaths(options: PgliteTemplateOptions): PgliteTemplatePaths {
  return {
    templatePath: resolve(options.cacheDir, `${options.templateName}.tar.gz`),
    fingerprintPath: resolve(options.cacheDir, `${options.templateName}.fingerprint`),
  };
}

/**
 * Build (or reuse) the gzip'd PGlite data-dir template with all migrations
 * applied. Returns the template path; skips the build when the cached
 * fingerprint matches the current migrations.
 */
export async function buildPgliteTemplate(
  options: PgliteTemplateOptions,
): Promise<{ templatePath: string; rebuilt: boolean }> {
  const { templatePath, fingerprintPath } = pgliteTemplatePaths(options);
  const fingerprint = computeMigrationsFingerprint(options.migrationsDir);

  mkdirSync(options.cacheDir, { recursive: true });

  if (existsSync(templatePath) && existsSync(fingerprintPath)) {
    const cached = readFileSync(fingerprintPath, "utf-8").trim();
    if (cached === fingerprint) {
      return { templatePath, rebuilt: false };
    }
  }

  const { PGlite } = await import("@electric-sql/pglite");
  const pg = new PGlite();

  for (const sql of readMigrationSql(options.migrationsDir)) {
    await pg.exec(sql);
  }

  const dump = await pg.dumpDataDir("gzip");
  const buffer = Buffer.from(await dump.arrayBuffer());
  writeFileSync(templatePath, buffer);
  writeFileSync(fingerprintPath, fingerprint);

  await pg.close();
  return { templatePath, rebuilt: true };
}

export interface PostgresWorkerOptions {
  /** Connection URL whose database segment names the template database. */
  testDatabaseUrl: string;
  /** Template database name (e.g. "myapp_test"). */
  templateDbName: string;
  /** Absolute path to the Prisma migrations directory. */
  migrationsDir: string;
  /** Number of per-worker databases to clone. Default: 8. */
  workerCount?: number;
  /** Worker database name prefix. Default: "test_worker_". */
  workerPrefix?: string;
  /** Seconds to wait for PostgreSQL to accept connections. Default: 30. */
  maxWaitSeconds?: number;
}

/** Swap the database segment of a connection URL. */
function withDatabase(url: string, database: string): string {
  return url.replace(/\/[^/?]+(\?|$)/, `/${database}$1`);
}

/**
 * Prepare real-PostgreSQL test databases: wait for the server, ensure the
 * template database exists, reset + migrate it, then clone one database per
 * worker from the template.
 */
export async function setupPostgresWorkerDatabases(options: PostgresWorkerOptions): Promise<void> {
  const { default: pg } = await import("pg");
  const workerCount = options.workerCount ?? 8;
  const workerPrefix = options.workerPrefix ?? "test_worker_";
  const maxAttempts = options.maxWaitSeconds ?? 30;
  const adminUrl = withDatabase(options.testDatabaseUrl, "postgres");
  const templateUrl = withDatabase(options.testDatabaseUrl, options.templateDbName);

  // Wait for PostgreSQL to accept connections — guards against timing races
  // when tests start before a sidecar container is fully ready.
  for (let i = 0; i < maxAttempts; i++) {
    try {
      const client = new pg.Client({ connectionString: adminUrl });
      await client.connect();
      await client.end();
      break;
    } catch {
      if (i === maxAttempts - 1) {
        throw new Error(`PostgreSQL not ready after ${maxAttempts}s`);
      }
      await new Promise<void>((res) => {
        setTimeout(res, 1000);
      });
    }
  }

  // Ensure the template database exists (self-heals fresh environments).
  {
    const client = new pg.Client({ connectionString: adminUrl });
    await client.connect();
    try {
      const res = await client.query("SELECT 1 FROM pg_database WHERE datname = $1", [
        options.templateDbName,
      ]);
      if (res.rowCount === 0) {
        await client.query(`CREATE DATABASE ${options.templateDbName}`);
      }
    } finally {
      await client.end();
    }
  }

  // Reset + migrate the template, then clone per-worker databases from it.
  const client = new pg.Client({ connectionString: templateUrl });
  await client.connect();
  try {
    await client.query(
      `SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname = $1 AND pid <> pg_backend_pid()`,
      [options.templateDbName],
    );

    await client.query("DROP SCHEMA public CASCADE");
    await client.query("CREATE SCHEMA public");

    for (const sql of readMigrationSql(options.migrationsDir)) {
      await client.query(sql);
    }

    for (let i = 0; i < workerCount; i++) {
      const workerDb = `${workerPrefix}${i}`;
      await client.query(
        `SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname = $1 AND pid <> pg_backend_pid()`,
        [workerDb],
      );
      await client.query(`DROP DATABASE IF EXISTS ${workerDb}`);
      await client.query(`CREATE DATABASE ${workerDb} TEMPLATE ${options.templateDbName}`);
    }
  } finally {
    await client.end();
  }
}

export interface PrismaTestGlobalSetupOptions {
  /** Absolute path to the Prisma migrations directory. */
  migrationsDir: string;
  /** Template database name for real-PostgreSQL mode. */
  templateDbName: string;
  /** Cache name for the PGlite template dump (e.g. "myapp-test-template"). */
  templateName: string;
  /** Cache directory. Default: <cwd>/node_modules/.cache. */
  cacheDir?: string;
  /** Per-worker database count for real-PostgreSQL mode. Default: 8. */
  workerCount?: number;
}

/**
 * Build a vitest globalSetup function that prepares the test databases.
 * Picks real-PostgreSQL mode when TEST_DATABASE_URL is set, PGlite otherwise.
 */
export function createPrismaTestGlobalSetup(
  options: PrismaTestGlobalSetupOptions,
): () => Promise<void> {
  return async () => {
    const testDatabaseUrl = process.env.TEST_DATABASE_URL;
    if (testDatabaseUrl) {
      await setupPostgresWorkerDatabases({
        testDatabaseUrl,
        templateDbName: options.templateDbName,
        migrationsDir: options.migrationsDir,
        workerCount: options.workerCount,
      });
    } else {
      await buildPgliteTemplate({
        migrationsDir: options.migrationsDir,
        cacheDir: options.cacheDir ?? resolve(process.cwd(), "node_modules/.cache"),
        templateName: options.templateName,
      });
    }
  };
}
