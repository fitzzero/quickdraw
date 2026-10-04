// The app's own token check and grants, for the README's server example.

import type { AccessLevel } from "@fitzzero/quickdraw-core";
import { verifyJWT } from "@fitzzero/quickdraw-core/server/auth";
import { db } from "./db";
import type { AppPrincipal } from "./quickdraw";

const SECRET = process.env.JWT_SECRET ?? "";

/** The user a bearer token signs in, or `null` for no token. */
export async function verifySession(token: unknown): Promise<AppPrincipal | null> {
  if (typeof token !== "string") {
    return null;
  }
  const payload = await verifyJWT(token, SECRET);
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
