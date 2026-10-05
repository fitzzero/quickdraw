import type { HealthServiceMethods } from "./health.js";
// ── quickdraw-labels:start ──
import type { LabelDTO, LabelServiceMethods } from "./label.js";
// ── quickdraw-labels:end ──
import type { ProjectDTO, ProjectServiceMethods } from "./project.js";
import type { TaskDTO, TaskServiceMethods } from "./task.js";
import type { UserDTO, UserServiceMethods } from "./user.js";

// ============================================================================
// Combined Service Methods Map (for client typing)
// ============================================================================

export interface ServiceMethodsMap {
  projectService: ProjectServiceMethods;
  taskService: TaskServiceMethods;
  userService: UserServiceMethods;
  // A fork made without labels strips them (the template's carve-outs)
  // ── quickdraw-labels:start ──
  labelService: LabelServiceMethods;
  // ── quickdraw-labels:end ──
  healthService: HealthServiceMethods;
}

// ============================================================================
// Subscription Data Map (for useSubscription typing)
// ============================================================================

export interface SubscriptionDataMap {
  projectService: ProjectDTO;
  taskService: TaskDTO;
  userService: UserDTO;
  // ── quickdraw-labels:start ──
  labelService: LabelDTO;
  // ── quickdraw-labels:end ──
}
