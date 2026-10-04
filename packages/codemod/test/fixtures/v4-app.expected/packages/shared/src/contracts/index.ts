// The app's contracts, written by @fitzzero/quickdraw-codemod. The web client is
// built from `contracts` (`createQuickdrawClient(contracts)`), keyed by service
// name so every 4.x call site keeps its name: `qd.projectService.getProject`.

import { healthContract } from "./health.js";
import { labelContract } from "./label.js";
import { projectContract } from "./project.js";
import { taskContract } from "./task.js";
import { userContract } from "./user.js";

export { healthContract, labelContract, projectContract, taskContract, userContract };

export const contracts = {
  healthService: healthContract,
  labelService: labelContract,
  projectService: projectContract,
  taskService: taskContract,
  userService: userContract,
};
