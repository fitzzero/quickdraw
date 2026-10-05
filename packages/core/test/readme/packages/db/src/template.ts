// Where the template app's test database comes from: its migrations, and the
// template every test worker boots from (`./testing.ts`), cached under
// node_modules. The global setup builds it once per run (`../../../globalSetup.ts`).

import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { PgliteTemplateOptions } from "@fitzzero/quickdraw-core/testing/prisma";

const here = dirname(fileURLToPath(import.meta.url));

export const TEST_TEMPLATE: PgliteTemplateOptions = {
  migrationsDir: resolve(here, "../../../../prisma/migrations"),
  cacheDir: resolve(here, "../../../../../node_modules/.cache"),
  templateName: "quickdraw-readme-test",
};
