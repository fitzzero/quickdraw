// The database package's test helper, which imports quickdraw's 4.x test
// entry point: a workspace package beyond shared, api and web.
import { resetDatabase } from "@fitzzero/quickdraw-core/server/testing/prisma";
import { prisma } from "./index.js";

/** Empties every table between tests. */
export async function resetTestDatabase(): Promise<void> {
  await resetDatabase(prisma);
}
