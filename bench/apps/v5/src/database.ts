import { trackPrisma } from "@fitzzero/quickdraw-core/prisma";
import { createPrisma, databaseUrl } from "./db";

/**
 * The Prisma client. Its query events count SQL statements for the harness
 * (src/instrument.ts); nothing writes through it directly.
 */
export const prisma = createPrisma(databaseUrl());

/**
 * The tracked client the services receive as `db`: every write made through
 * it reaches the subscribers of the rows it touched. Applied last, as
 * trackPrisma requires.
 */
export const db = trackPrisma(prisma);
