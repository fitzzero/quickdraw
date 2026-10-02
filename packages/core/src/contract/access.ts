// Access levels and access-control lists, unchanged from 4.1
// (`legacy-src/shared/types.ts:7-14`). The level names are stored in app data
// (`User.serviceAccess`, JSON access lists), so they never change.

export type AccessLevel = "Public" | "Read" | "Moderate" | "Admin";

export type ACE = {
  userId: string;
  level: AccessLevel;
};

export type ACL = ACE[];
