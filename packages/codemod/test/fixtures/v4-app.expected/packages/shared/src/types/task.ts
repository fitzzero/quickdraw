// ============================================================================
// Task Service Types
// ============================================================================

/** Wire shape of a task (subscription payloads + emitUpdate). */
export interface TaskDTO {
  id: string;
  projectId: string;
  title: string;
  status: string;
  ordinal: number;
  assigneeId: string | null;
  notes: string | null;
  createdAt: string;
  updatedAt: string;
}

/** Item of the `byProject` collection: what a board column shows. */
export interface TaskCard {
  id: string;
  title: string;
  status: string;
  ordinal: number;
}

export type TaskCollections = {
  byProject: { item: TaskCard };
};

export interface TaskServiceMethods {
  createTask: {
    payload: { projectId: string; title: string };
    response: TaskDTO;
  };
  updateTask: {
    payload: { id: string; title?: string; notes?: string | null };
    response: TaskDTO | null;
  };
  moveTask: {
    payload: { taskId: string; status: string; ordinal: number };
    response: { id: string };
  };
  listTasks: {
    payload: { projectId: string };
    response: TaskCard[];
  };
  reindexProject: {
    payload: { projectId: string };
    response: { count: number };
  };
}
