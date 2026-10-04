import { createQuickdrawClient } from "@fitzzero/quickdraw-core/client";
import { contracts } from "@project/shared";

// One typed client for the app: qd.task and qd.project, from the contracts.
export const qd = createQuickdrawClient(contracts);
