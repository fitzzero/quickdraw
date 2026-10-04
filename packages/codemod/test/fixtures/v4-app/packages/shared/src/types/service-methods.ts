import type { HealthServiceMethods } from "./health.js";
import type { LabelDTO, LabelServiceMethods } from "./label.js";
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
  labelService: LabelServiceMethods;
  healthService: HealthServiceMethods;
}

// ============================================================================
// Subscription Data Map (for useSubscription typing)
// ============================================================================

export interface SubscriptionDataMap {
  projectService: ProjectDTO;
  taskService: TaskDTO;
  userService: UserDTO;
  labelService: LabelDTO;
}
