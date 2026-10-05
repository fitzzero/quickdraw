// The tracked-writes tests' harness: a PGlite test database, an untracked
// client for setup and assertions, a tracked client on the same database,
// and helpers to run code in a unit of work and see what it flushed.

import {
  createTestDatabase,
  type PrismaClient,
  type TestDatabase,
} from "../../../test/prisma/setup";
import type { Logger } from "../../contract/logger";
import { storageOf, type StorageAdapter } from "../../server/storage";
import type { WriteRecord } from "../../server/uow/types";
import { createRecordingSink } from "../../testing/recordingSink";
import { trackPrisma } from "../trackPrisma";

/** The interested columns the tests register: scope, parent and membership columns. */
export const INTEREST = {
  task: ["projectId", "status", "parentTaskId"],
  projectMember: ["projectId", "userId", "role"],
} as const;

/** A logger that keeps its warnings. */
export interface CapturingLogger extends Logger {
  readonly warnings: string[];
}

export function captureLogger(): CapturingLogger {
  const warnings: string[] = [];
  const ignore = (): void => undefined;
  const logger: CapturingLogger = {
    warnings,
    debug: ignore,
    info: ignore,
    error: ignore,
    warn: (message) => {
      warnings.push(message);
    },
    child: () => logger,
  };
  return logger;
}

/** A statement held at the database: see {@link pauseNext}. */
export interface PausedStatement {
  /** Resolves when a matching statement arrived; it waits there until `release()`. */
  readonly reached: Promise<void>;
  release(): void;
  /** Stops watching statements, and releases one it holds. */
  restore(): void;
}

/**
 * Holds the next statement PGlite receives whose SQL matches `pattern` until
 * `release()`. PGlite runs one statement at a time, so this is how a test
 * runs other work between a tracked write's own read and its write.
 */
export function pauseNext(database: TestDatabase, pattern: RegExp): PausedStatement {
  const pglite = database.pglite as unknown as {
    query: (sql: string, ...rest: unknown[]) => Promise<unknown>;
  };
  const original = pglite.query;
  let release = (): void => undefined;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  let arrive = (): void => undefined;
  const reached = new Promise<void>((resolve) => {
    arrive = resolve;
  });
  let armed = true;
  pglite.query = async (sql: string, ...rest: unknown[]): Promise<unknown> => {
    if (armed && pattern.test(sql)) {
      armed = false;
      arrive();
      await gate;
    }
    return original.call(database.pglite, sql, ...rest);
  };
  return {
    reached,
    release,
    restore: () => {
      pglite.query = original;
      release();
    },
  };
}

/** What `inUnit` returns: the function's value and the merged writes its unit flushed. */
export interface UnitResult<T> {
  readonly value: T;
  readonly writes: WriteRecord[];
}

export interface Harness {
  readonly database: TestDatabase;
  /** Untracked: for setup and assertions. */
  readonly prisma: PrismaClient;
  /** Tracked, with {@link INTEREST}. */
  readonly db: PrismaClient;
  readonly storage: StorageAdapter;
  readonly logger: CapturingLogger;
  /** Runs `fn` in a unit of work of the tracked client and flushes it. */
  inUnit<T>(fn: () => T | PromiseLike<T>): Promise<UnitResult<T>>;
  /** A user and a project owned by them, written untracked. */
  seed(): Promise<{ readonly userId: string; readonly projectId: string }>;
  close(): Promise<void>;
}

export async function createHarness(): Promise<Harness> {
  const database = await createTestDatabase();
  const logger = captureLogger();
  const db = trackPrisma(database.prisma, { interest: INTEREST, logger, development: true });
  const storage = storageOf(db);
  if (storage === undefined) {
    throw new Error("trackPrisma's client carries no storage adapter");
  }
  return {
    database,
    prisma: database.prisma,
    db,
    storage,
    logger,
    async inUnit<T>(fn: () => T | PromiseLike<T>): Promise<UnitResult<T>> {
      const sink = createRecordingSink();
      const unit = storage.unitOfWork.begin({ requestId: "test", transport: "internal", sink });
      const value = await unit.run(fn);
      await unit.flush();
      return { value, writes: sink.writes() };
    },
    async seed() {
      const user = await database.prisma.user.create({
        data: { email: `${crypto.randomUUID()}@example.com`, name: "Ada" },
      });
      const project = await database.prisma.project.create({
        data: { name: "Board", ownerId: user.id },
      });
      return { userId: user.id, projectId: project.id };
    },
    close: () => database.close(),
  };
}

/** Waits until work scheduled with `setImmediate` (an ambient flush) has run. */
export function nextTick(): Promise<void> {
  return new Promise((resolve) => {
    setImmediate(resolve);
  });
}
