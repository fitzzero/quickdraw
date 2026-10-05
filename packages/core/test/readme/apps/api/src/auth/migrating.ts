// The migration guide's examples for moving a 4.x app's hand-built sign-in
// onto the auth routes kit (MIGRATION.md, "Hand-built auth to the auth routes
// kit"). Sessions live in the README app's in-memory store here; an app
// passes `prismaSessions(db.session)` (`./sessions.ts`).

import type { AuthProfile } from "@fitzzero/quickdraw-core/server/auth";
import express, { type Express } from "express";
import { loadGrants, sessions } from "../auth";
import { db } from "../db";
import { qd, type AppPrincipal } from "../quickdraw";
import { projectService } from "../services/project";
import { taskService } from "../services/task";
import { listSeededUsers, upsertUser } from "./users";

const env = {
  CLIENT_URL: process.env.CLIENT_URL ?? "http://localhost:3000",
  API_URL: process.env.API_URL ?? "http://localhost:4000",
  JWT_SECRET: process.env.JWT_SECRET ?? "",
  GOOGLE_CLIENT_ID: process.env.GOOGLE_CLIENT_ID,
  GOOGLE_CLIENT_SECRET: process.env.GOOGLE_CLIENT_SECRET,
  DISCORD_CLIENT_ID: process.env.DISCORD_CLIENT_ID,
  DISCORD_CLIENT_SECRET: process.env.DISCORD_CLIENT_SECRET,
  ENABLE_DEV_CREDENTIALS: process.env.ENABLE_DEV_CREDENTIALS,
};

/** The app's own exchange of an embedded Activity's code for the Discord profile (not shown). */
declare function activityProfile(code: string): Promise<AuthProfile>;

// #region wiring
import {
  createAuthRoutes,
  discord,
  google,
  mock,
  requireSession,
  sessionOf,
  socketAuth,
  type SessionKeys,
} from "@fitzzero/quickdraw-core/server/auth";

// `sessions`: a SessionStore over the Session table, `prismaSessions(db.session)`
const keys: SessionKeys = { sessions, jwtSecret: env.JWT_SECRET };
const allowedOrigins = [env.CLIENT_URL];

/** A development handshake's user (`auth: { userId }`): the Godot editor, load-test bots. */
async function devUser(userId: string): Promise<AppPrincipal | null> {
  const user = await db.user.findUnique({ where: { id: userId }, select: { id: true } });
  return user === null ? null : { userId: user.id, kind: "user" };
}

export const app: Express = express();
app.set("trust proxy", 1);
app.use(
  createAuthRoutes({
    ...keys,
    providers: [
      // each is left out where its credentials are not set
      google.optional({ clientId: env.GOOGLE_CLIENT_ID, clientSecret: env.GOOGLE_CLIENT_SECRET }),
      discord.optional({
        clientId: env.DISCORD_CLIENT_ID,
        clientSecret: env.DISCORD_CLIENT_SECRET,
      }),
      mock({ listUsers: listSeededUsers }),
    ],
    // 4.x's callback tail: find or create the user (and its account row); null refuses
    onLogin: (profile) => upsertUser(profile),
    allowedOrigins,
    publicUrl: env.API_URL,
    // the web app's pages: /auth/callback signed in, /auth/login?error=state|denied|failed
    successPath: "/auth/callback",
    errorPath: "/auth/login",
    onRevoke: (userId, sessionId) =>
      server.access.disconnectUser(userId, sessionId === null ? {} : { sessionId }),
  }),
);

// the app's own REST routes: was createRequireAuth({ getSession }) and req.userId
app.post("/api/push/resubscribe", express.json(), requireSession(keys), (req, res) => {
  // the session's user and principal, typed; call the services as it (the README's REST example)
  const { userId } = sessionOf(req);
  res.json({ userId });
});

export const server = qd.createServer({
  app,
  services: [projectService, taskService],
  db,
  auth: {
    authenticate: socketAuth({
      ...keys,
      allowedOrigins,
      loadPrincipal: (userId): AppPrincipal => ({ userId, kind: "user" }),
      // never in production: socketAuth refuses it there
      devCredentials: env.ENABLE_DEV_CREDENTIALS === "true" ? devUser : undefined,
    }),
    loadServiceAccess: (userId) => loadGrants(userId),
    serviceAccessSource: { model: "user", column: "serviceAccess" },
  },
});
// #endregion

// #region activity
import { issueSession, setSessionCookie } from "@fitzzero/quickdraw-core/server/auth";

// A sign-in the kit's redirecting providers do not cover, such as a Discord Activity's embedded
// SDK handing the page a code: the app exchanges it, then starts an ordinary session, which
// socketAuth and requireSession accept like any other.
app.post("/auth/discord/activity", express.json(), (req, res) => {
  void (async () => {
    const { code } = req.body as { readonly code?: unknown };
    if (typeof code !== "string" || code === "") {
      res.status(422).json({ error: "VALIDATION", message: "Send the Activity's code" });
      return;
    }
    const userId = await upsertUser(await activityProfile(code));
    if (userId === null) {
      res.status(401).json({ error: "UNAUTHENTICATED", message: "Sign-in refused" });
      return;
    }
    const { token } = await issueSession(keys, userId, {
      provider: "discord-activity",
      userAgent: req.get("user-agent"),
      ip: req.ip,
    });
    // best effort: a third-party iframe may refuse the cookie, so the page sends auth.token
    setSessionCookie(res, token);
    res.json({ token });
  })();
});
// #endregion
