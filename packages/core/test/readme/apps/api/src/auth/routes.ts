// The README's auth routes kit example.

import express, { type Express } from "express";
import { loadGrants } from "../auth";
import { db } from "../db";
import { qd, type AppPrincipal } from "../quickdraw";
import { projectService } from "../services/project";
import { taskService } from "../services/task";
import { createGuestUser, listSeededUsers, upsertUser } from "./users";

/** The app's settings, read once at startup. */
function setting(name: string): string {
  const value = process.env[name];
  if (value === undefined || value === "") {
    throw new Error(`${name} is not set`);
  }
  return value;
}

const env = {
  CLIENT_URL: setting("CLIENT_URL"),
  API_URL: setting("API_URL"),
  JWT_SECRET: setting("JWT_SECRET"),
  GOOGLE_CLIENT_ID: setting("GOOGLE_CLIENT_ID"),
  GOOGLE_CLIENT_SECRET: setting("GOOGLE_CLIENT_SECRET"),
  DISCORD_CLIENT_ID: setting("DISCORD_CLIENT_ID"),
  DISCORD_CLIENT_SECRET: setting("DISCORD_CLIENT_SECRET"),
};
const services = [projectService, taskService];

// #region routes
import {
  createAuthRoutes,
  createMemorySessionStore,
  discord,
  google,
  guest,
  mock,
  socketAuth,
} from "@fitzzero/quickdraw-core/server/auth";
import { createCallLimiter } from "@fitzzero/quickdraw-core/server/express";

// the web app's origins: one list for both
const allowedOrigins = [env.CLIENT_URL];
// in production: a store over your database (below)
const sessions = createMemorySessionStore();

export const app: Express = express();
// behind a proxy, so the rate limits see the client's IP
app.set("trust proxy", 1);
// a web app on another origin also needs CORS with credentials on these routes
app.use(
  createAuthRoutes({
    providers: [
      google({ clientId: env.GOOGLE_CLIENT_ID, clientSecret: env.GOOGLE_CLIENT_SECRET }),
      discord({ clientId: env.DISCORD_CLIENT_ID, clientSecret: env.DISCORD_CLIENT_SECRET }),
      // served only while isMockOAuthEnabled()
      mock({ listUsers: listSeededUsers }),
      guest({ createUser: (input) => createGuestUser(input) }),
    ],
    sessions,
    // 32 characters or more
    jwtSecret: env.JWT_SECRET,
    // the user's id, or null to refuse
    onLogin: (profile) => upsertUser(profile),
    allowedOrigins,
    // redirect URIs: {publicUrl}/auth/{provider}/callback
    publicUrl: env.API_URL,
    successPath: "/auth/callback",
    errorPath: "/auth/login",
    // a revoked session's open sockets: logout ends its own, logout-all every one of the user
    onRevoke: (userId, sessionId) =>
      server.access.disconnectUser(userId, sessionId === null ? {} : { sessionId }),
  }),
);

export const server = qd.createServer({
  app,
  services,
  db,
  auth: {
    authenticate: socketAuth({
      sessions,
      jwtSecret: env.JWT_SECRET,
      allowedOrigins,
      loadPrincipal: (userId): AppPrincipal => ({ userId, kind: "user" }),
    }),
    loadServiceAccess: (userId) => loadGrants(userId),
  },
  // the HTTP transport has no limit of its own
  http: { rateLimit: createCallLimiter() },
});
// #endregion
