// The README example app's global test setup, as the template's own would
// be: migrates the test database's template once per run, which every test
// worker then boots from (`packages/db/src/testing.ts`). packages/core's
// `readme` vitest project runs the app's component tests with it.

import { buildPgliteTemplate } from "@fitzzero/quickdraw-core/testing/prisma";
import { TEST_TEMPLATE } from "./packages/db/src/template";

export async function setup(): Promise<void> {
  await buildPgliteTemplate(TEST_TEMPLATE);
}
