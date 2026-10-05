// Access levels and access-control lists, unchanged from 4.1
// (4.1 `src/shared/types.ts:7-14`). The level names are stored in app data
// (`User.serviceAccess`, JSON access lists), so they never change.

export type AccessLevel = "Public" | "Read" | "Moderate" | "Admin";

/** Every access level, lowest first. */
export const ACCESS_LEVELS: readonly AccessLevel[] = Object.freeze([
  "Public",
  "Read",
  "Moderate",
  "Admin",
]);

/** True when `value` is one of the four access level names. */
export function isAccessLevel(value: unknown): value is AccessLevel {
  return typeof value === "string" && (ACCESS_LEVELS as readonly string[]).includes(value);
}

export type ACE = {
  userId: string;
  level: AccessLevel;
};

export type ACL = ACE[];
