// The benchmark board's contracts, as an app's shared package exports them:
// the server implements them (src/services) and the load generator's 5.0
// driver (bench/src/drivers/v5) reads its collection and method names from
// them, as a web client would.

import { projectContract } from "./project";
import { taskContract } from "./task";

export * from "./schemas";
export { projectContract, taskContract };

/** The app's contracts, keyed for a typed client. */
export const contracts = { project: projectContract, task: taskContract };
