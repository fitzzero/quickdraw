// The README's SessionStore example. Typed against the part of Prisma's
// generated `session` delegate it calls, so it compiles without a Session
// model in this repo's test schema; in an app, pass `prismaSessions(db.session)`.

import type { AuthSession, SessionMeta } from "@fitzzero/quickdraw-core/server/auth";

// #region store
import type { SessionStore } from "@fitzzero/quickdraw-core/server/auth";

/** The methods of Prisma's `db.session` delegate the store calls. */
interface SessionTable {
  create(args: { data: SessionMeta & { userId: string } }): Promise<AuthSession>;
  findUnique(args: { where: { id: string } }): Promise<AuthSession | null>;
  deleteMany(args: { where: { id: string } | { userId: string } }): Promise<unknown>;
}

export function prismaSessions(sessions: SessionTable): SessionStore {
  return {
    create: (userId, meta) => sessions.create({ data: { userId, ...meta } }),
    get: (id) => sessions.findUnique({ where: { id } }),
    revoke: (id) => sessions.deleteMany({ where: { id } }),
    revokeAll: (userId) => sessions.deleteMany({ where: { userId } }),
  };
}
// #endregion
