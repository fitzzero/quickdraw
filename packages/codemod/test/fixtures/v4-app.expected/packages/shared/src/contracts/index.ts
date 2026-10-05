// The app's contracts, written by @fitzzero/quickdraw-codemod. The web client is
// built from `contracts` (`createQuickdrawClient(contracts)`), keyed by service
// name so every 4.x call site keeps its name: `qd.projectService.getProject`.

import { healthContract } from "./health.js";
import { projectContract } from "./project.js";
import { taskContract } from "./task.js";
import { userContract } from "./user.js";
// ── quickdraw-labels:start ──
import { labelContract } from "./label.js";
// ── quickdraw-labels:end ──

export { healthContract, projectContract, taskContract, userContract };
// ── quickdraw-labels:start ──
export { labelContract };
// ── quickdraw-labels:end ──

export const contracts = {
  healthService: healthContract,
  projectService: projectContract,
  taskService: taskContract,
  userService: userContract,
  // ── quickdraw-labels:start ──
  labelService: labelContract,
  // ── quickdraw-labels:end ──
};
