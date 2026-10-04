// The README's example of extending `ctx` through `initQuickdraw({ context })`.

import { initQuickdraw, type Principal } from "@fitzzero/quickdraw-core/server";
import type { db } from "../../db";

// #region context
interface AppContext {
  /** The tenant every query of this call is scoped to. */
  readonly tenantId: string;
}

export const qd = initQuickdraw<{ db: typeof db; principal: Principal; context: AppContext }>({
  // runs once per call, before access is checked, so custom checks see it too
  context: (base) => ({ tenantId: String(base.principal?.claims?.tenant ?? "public") }),
});
// #endregion
