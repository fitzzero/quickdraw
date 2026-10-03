// The template app's database package, `@project/db`, for the README's
// examples: the Prisma client over core's test schema (test/prisma). Only
// typechecked, never run.

import { PGlite } from "@electric-sql/pglite";
import { PrismaPGlite } from "pglite-prisma-adapter";
import { PrismaClient } from "../../../../prisma/generated/client";

export { PrismaClient };

/** The app's Prisma client: untracked. Services and jobs use the tracked `db` instead. */
export const prisma = new PrismaClient({ adapter: new PrismaPGlite(new PGlite()) });
