import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "../generated/prisma/client";

/** pg's default pool size, which `new PrismaPg({ connectionString })` keeps. */
export const DB_POOL_MAX = 10;

/**
 * The Prisma 7 client the way Prisma documents it: a pg driver adapter built
 * from the connection string, nothing tuned. Query events are on only so the
 * harness can count SQL statements (the same instrumentation every app under
 * bench/apps/ must carry).
 */
export function createPrisma(connectionString: string) {
  return new PrismaClient({
    adapter: new PrismaPg({ connectionString }),
    log: [{ emit: "event", level: "query" }],
  });
}

export type Db = ReturnType<typeof createPrisma>;

export function databaseUrl(): string {
  const url = process.env.DATABASE_URL;
  if (!url) {
    throw new Error("DATABASE_URL is not set (the bench runner passes it)");
  }
  return url;
}
