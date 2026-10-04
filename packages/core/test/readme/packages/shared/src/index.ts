import { labelContract } from "./contracts/label";
import { projectContract } from "./contracts/project";
import { taskContract } from "./contracts/task";

export * from "./schemas";
export { labelContract, projectContract, taskContract };

/** The app's contracts, keyed as the web client names its services: `qd.task`, `qd.project`. */
export const contracts = { label: labelContract, project: projectContract, task: taskContract };
