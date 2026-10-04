import type { AccessLevel, ACL } from "@fitzzero/quickdraw-core";

// ============================================================================
// Project Service Types
// ============================================================================

/** Wire shape of a project (subscription payloads + emitUpdate). */
export interface ProjectDTO {
  id: string;
  name: string;
  ownerId: string;
  acl: ACL | null;
  archived: boolean;
}

/** Item of the `mine` collection: one row per project the scope user owns. */
export interface ProjectListItem {
  id: string;
  name: string;
}

/** Collections served by projectService: `mine` is scoped by the owner's user id. */
export type ProjectCollections = {
  mine: { item: ProjectListItem };
};

export interface ProjectMemberDTO {
  id: string;
  userId: string;
  role: AccessLevel;
}

export interface ProjectServiceMethods {
  createProject: {
    payload: { name: string };
    response: { id: string };
  };
  getProject: {
    payload: { id: string };
    response: ProjectDTO | null;
  };
  renameProject: {
    payload: { id: string; name: string };
    response: ProjectDTO | null;
  };
  listMyProjects: {
    payload: { page?: number; pageSize?: number };
    response: ProjectDTO[];
  };
  getMembers: {
    payload: { projectId: string };
    response: ProjectMemberDTO[];
  };
  shareProject: {
    payload: { id: string; userId: string; level: AccessLevel };
    response: { id: string };
  };
  archiveProject: {
    payload: { id: string };
    response: { id: string; archived: true };
  };
  deleteProject: {
    payload: { id: string };
    response: { id: string; deleted: true };
  };
}
