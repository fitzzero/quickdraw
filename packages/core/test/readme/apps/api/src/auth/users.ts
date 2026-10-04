// The app's own user records, for the README's auth routes example.

import { QuickdrawError } from "@fitzzero/quickdraw-core";
import type { AuthProfile, MockOAuthUser } from "@fitzzero/quickdraw-core/server/auth";
import { db } from "../db";

/** Finds or creates the user a provider's profile signs in; `null` refuses the sign-in. */
export async function upsertUser(profile: AuthProfile): Promise<string | null> {
  if (profile.email === null || !profile.emailVerified) {
    return null;
  }
  const user = await db.user.upsert({
    where: { email: profile.email },
    create: { email: profile.email, name: profile.name ?? profile.email },
    update: {},
  });
  return user.id;
}

/** Creates a guest from the request body `{ name }`. */
export async function createGuestUser(input: unknown): Promise<string> {
  const name =
    typeof input === "object" && input !== null ? (input as { name?: unknown }).name : undefined;
  if (typeof name !== "string" || name.length === 0) {
    throw new QuickdrawError("VALIDATION", "A guest needs a name");
  }
  const user = await db.user.create({
    data: { name, email: `${crypto.randomUUID()}@guest.invalid` },
  });
  return user.id;
}

/** The demo accounts the development mock provider offers. */
export async function listSeededUsers(): Promise<MockOAuthUser[]> {
  const users = await db.user.findMany({ where: { email: { endsWith: "@demo.test" } }, take: 20 });
  return users.map((user) => ({ id: user.id, email: user.email, name: user.name }));
}
