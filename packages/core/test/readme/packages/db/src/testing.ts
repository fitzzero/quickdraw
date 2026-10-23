// The template app's test database: what `@project/db` is while its tests
// run (packages/core's `readme` vitest project resolves it here), one
// in-memory PGlite database per test worker, booted from the template the
// global setup migrated once.

import { openPgliteFromTemplate, withSavepoints } from "@fitzzero/quickdraw-core/testing/prisma";
import { PrismaPGlite } from "pglite-prisma-adapter";
import { PrismaClient } from "../../../../prisma/generated/client";
import { TEST_TEMPLATE } from "./template";

export { PrismaClient };

// #region worker
// this worker's own database: the migrated template, loaded in milliseconds
const pglite = await openPgliteFromTemplate(TEST_TEMPLATE);
// withSavepoints: nested transactions (tx.$transaction inside one) run here as on PostgreSQL
export const prisma = new PrismaClient({ adapter: withSavepoints(new PrismaPGlite(pglite)) });
// #endregion
