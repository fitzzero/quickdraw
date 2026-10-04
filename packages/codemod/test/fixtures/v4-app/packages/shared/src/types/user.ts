import type { AccessLevel } from "@fitzzero/quickdraw-core";

// ============================================================================
// User Service Types
// ============================================================================

/**
 * Wire shape of a user. `email` and `serviceAccess` are protected fields:
 * stripped for subscribers without elevated access.
 */
export interface UserDTO {
  id: string;
  email: string;
  name: string;
  serviceAccess: Record<string, AccessLevel> | null;
}

export interface UserServiceMethods {
  getMe: {
    payload: Record<string, never>;
    response: UserDTO | null;
  };
  updateUser: {
    payload: { id: string; name: string };
    response: { id: string; name: string } | { error: "name_taken" };
  };
  getProfile: {
    payload: { id: string };
    response: { id: string; name: string } | null;
  };
}
