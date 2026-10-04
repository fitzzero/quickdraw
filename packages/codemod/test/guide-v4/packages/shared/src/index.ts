import type { AccessLevel } from "@fitzzero/quickdraw-core";

export { serviceRoom } from "@fitzzero/quickdraw-core";

// #region maps
export interface TaskDTO {
  id: string;
  projectId: string;
  title: string;
  status: string;
  notes: string | null;
  createdAt: string;
}

export interface TaskServiceMethods {
  getTask: { payload: { id: string }; response: TaskDTO | null };
  renameTask: { payload: { id: string; title: string }; response: TaskDTO | null };
  archiveAll: { payload: { projectId: string }; response: { count: number } };
}

export interface ServiceMethodsMap {
  taskService: TaskServiceMethods;
}

export interface SubscriptionDataMap {
  taskService: TaskDTO;
}
// #endregion

export type TaskCollections = { byProject: { item: TaskDTO } };

export interface HealthServiceMethods {
  ping: { payload: Record<string, never>; response: { at: string } };
}

export interface MemberDTO {
  userId: string;
  role: AccessLevel;
}

// #region events
declare module "@fitzzero/quickdraw-core" {
  interface QuickdrawEventMap {
    "task:archived": { id: string };
  }
}
// #endregion
