import { initQuickdraw, type Principal } from "@fitzzero/quickdraw-core/server";
import type { contracts } from "./contracts";
import type { db } from "./database";

// The app's types, stated once: every service, handler and caller is typed from them.
export const qd = initQuickdraw<{
  db: typeof db;
  principal: Principal;
  contracts: typeof contracts;
}>();
