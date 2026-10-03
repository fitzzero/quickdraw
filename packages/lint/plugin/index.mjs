// The quickdraw oxlint plugin (RFC 0003 section 14). Every rule is syntactic
// and takes a `baseline` option (see `baseline.mjs`). `oxlint.base.jsonc`
// turns on the rules about the 5.0 API; `oxlint.template.jsonc` adds the
// design-system rules for apps built from the quickdraw template.

import { withBaseline } from "./baseline.mjs";
import noAwaitVoidMutate from "./rules/no-await-void-mutate.mjs";
import noCrossServiceInternalImports from "./rules/no-cross-service-internal-imports.mjs";
import noDbCallInLoop from "./rules/no-db-call-in-loop.mjs";
import noEmitInLoop from "./rules/no-emit-in-loop.mjs";
import noForeignWrite from "./rules/no-foreign-write.mjs";
import noInlineAuthGuard from "./rules/no-inline-auth-guard.mjs";
import noLoadThenFilter from "./rules/no-load-then-filter.mjs";
import noManualEmit from "./rules/no-manual-emit.mjs";
import noManualRefetch from "./rules/no-manual-refetch.mjs";
import noNestedWrite from "./rules/no-nested-write.mjs";
import noPrismaInRoutes from "./rules/no-prisma-in-routes.mjs";
import noRawButtonStrings from "./rules/no-raw-button-strings.mjs";
import noRawSocket from "./rules/no-raw-socket.mjs";
import noRawSqlWrite from "./rules/no-raw-sql-write.mjs";
import noRawTooltipStrings from "./rules/no-raw-tooltip-strings.mjs";
import noRawTypographyStrings from "./rules/no-raw-typography-strings.mjs";
import noUnboundedRead from "./rules/no-unbounded-read.mjs";
import noUntrackedWrite from "./rules/no-untracked-write.mjs";
import noUntypedClient from "./rules/no-untyped-client.mjs";
import noV4Api from "./rules/no-v4-api.mjs";

const rules = {
  // Tracked writes
  "no-untracked-write": noUntrackedWrite,
  "no-foreign-write": noForeignWrite,
  "no-nested-write": noNestedWrite,
  "no-raw-sql-write": noRawSqlWrite,
  // Frames and access
  "no-manual-emit": noManualEmit,
  "no-inline-auth-guard": noInlineAuthGuard,
  // Performance
  "no-unbounded-read": noUnboundedRead,
  "no-db-call-in-loop": noDbCallInLoop,
  "no-emit-in-loop": noEmitInLoop,
  "no-load-then-filter": noLoadThenFilter,
  // Layering
  "no-prisma-in-routes": noPrismaInRoutes,
  "no-cross-service-internal-imports": noCrossServiceInternalImports,
  // The typed client
  "no-await-void-mutate": noAwaitVoidMutate,
  "no-untyped-client": noUntypedClient,
  "no-manual-refetch": noManualRefetch,
  "no-raw-socket": noRawSocket,
  // Migration from 4.x
  "no-v4-api": noV4Api,
  // Design system (oxlint.template.jsonc)
  "no-raw-button-strings": noRawButtonStrings,
  "no-raw-tooltip-strings": noRawTooltipStrings,
  "no-raw-typography-strings": noRawTypographyStrings,
};

/** @type {import('eslint').ESLint.Plugin} */
export default {
  meta: { name: "quickdraw" },
  rules: Object.fromEntries(
    Object.entries(rules).map(([name, rule]) => [name, withBaseline(rule)]),
  ),
};
