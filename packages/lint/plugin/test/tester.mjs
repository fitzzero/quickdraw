// Runs rule tests under oxlint's own RuleTester (`oxlint/plugins-dev`): the
// same parser, AST, scope analysis and plugin runtime as the oxlint CLI,
// inside vitest. Relative test filenames resolve against this directory, so
// `apps/api/src/services/task.ts` is linted as that path of an app.

import { fileURLToPath } from "node:url";
import { describe, it } from "vitest";
import { RuleTester } from "oxlint/plugins-dev";
import plugin from "../index.mjs";

RuleTester.describe = describe;
RuleTester.it = it;
RuleTester.itOnly = it.only;

const tester = new RuleTester({ cwd: fileURLToPath(new URL(".", import.meta.url)) });

/** Runs `tests` against the plugin's rule `name`, as the plugin ships it (with baseline support). */
export function run(name, tests) {
  tester.run(name, plugin.rules[name], tests);
}

/** A service file of the template's layout. */
export const SERVICE = "apps/api/src/services/task.ts";
/** A job file of the template's layout. */
export const JOB = "apps/api/src/jobs/sweep.ts";
/** A route file of the template's layout. */
export const ROUTE = "apps/api/src/routes/webhooks.ts";
/** A client component of the template's layout. */
export const COMPONENT = "apps/web/src/components/TaskCard.tsx";
/** A test next to a service. */
export const SERVICE_TEST = "apps/api/src/services/__tests__/task.test.ts";
