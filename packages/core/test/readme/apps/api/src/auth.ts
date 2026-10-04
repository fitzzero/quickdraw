// The app's sessions, token check and grants, for the README's server examples.

import type { AccessLevel } from "@fitzzero/quickdraw-core";
import { createMemorySessionStore, verifyJWT } from "@fitzzero/quickdraw-core/server/auth";
import { db } from "./db";
import type { AppPrincipal } from "./quickdraw";

/** Signs the session JWTs: one secret for the auth routes and `socketAuth`, 32 characters or more. */
export const jwtSecret = process.env.JWT_SECRET ?? "";

/** The sessions the auth routes issue. In production, a store over the database (see the auth routes kit). */
export const sessions = createMemorySessionStore();

/** The user a bearer token signs in, or `null` for no token. */
export async function verifySession(token: unknown): Promise<AppPrincipal | null> {
  if (typeof token !== "string") {
    return null;
  }
  const payload = await verifyJWT(token, jwtSecret);
  return payload === null ? null : { userId: payload.userId, kind: "user" };
}

/** A user's service-wide grants, as stored in `User.serviceAccess`. */
export async function loadGrants(userId: string): Promise<Record<string, AccessLevel>> {
  const user = await db.user.findUnique({ where: { id: userId }, select: { serviceAccess: true } });
  const stored: unknown = user?.serviceAccess;
  return typeof stored === "object" && stored !== null
    ? (stored as Record<string, AccessLevel>)
    : {};
}
