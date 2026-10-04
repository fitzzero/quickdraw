import { initQuickdraw, type Principal } from "@fitzzero/quickdraw-core/server";
import type { contracts } from "@project/shared";
import type { db } from "./db";

/** Who calls: a signed-in user, or an agent acting for one. */
export interface AppPrincipal extends Principal {
  readonly kind: "user" | "agent";
}

// The app's types, stated once: every service, handler and caller is typed from them.
export const qd = initQuickdraw<{
  db: typeof db;
  principal: AppPrincipal;
  contracts: typeof contracts;
}>();
