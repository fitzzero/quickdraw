// Auth utilities for @fitzzero/quickdraw-core/server/auth

export { createJWT, verifyJWT, type JWTPayload } from "./jwt";
export {
  createOAuthURL,
  exchangeOAuthCode,
  type OAuthProvider,
  type OAuthConfig,
  type OAuthTokenResponse,
} from "./oauth";
export { discordProvider, getDiscordAvatarUrl, type DiscordUser } from "./discord";
export { googleProvider, type GoogleUser } from "./google";
export {
  createMockOAuthProvider,
  registerMockOAuthProvider,
  isMockOAuthEnabled,
  DEFAULT_MOCK_PATH_PREFIX,
  type MockOAuthUser,
  type MockOAuthProviderOptions,
  type MockOAuthRouter,
  type RegisterMockOAuthOptions,
} from "./mock";
export {
  validateRedirectOrigin,
  OAUTH_RETURN_ORIGIN_COOKIE,
  type ValidateOriginOptions,
} from "./validateOrigin";
export {
  setSessionCookie,
  clearSessionCookie,
  SESSION_COOKIE,
  type CookieResponse,
  type CookieSettings,
  type SessionCookieOptions,
} from "./sessionCookie";
export {
  createRequireAuth,
  extractBearerOrCookieToken,
  type AuthRequest,
  type AuthResponse,
  type RequireAuthOptions,
} from "./restMiddleware";

// The auth routes kit (RFC 0003 section 12.6): sign-in routes for Google,
// Discord, the development mock and guests, sessions in the app's store, and
// the `authenticate` that checks them on every handshake and HTTP call
export { createAuthRoutes } from "./routes/createAuthRoutes";
export type {
  AuthCookieOptions,
  AuthProvider,
  AuthRoutes,
  AuthRoutesOptions,
} from "./routes/types";
export {
  socketAuth,
  type PrincipalLoader,
  type SessionAuthenticate,
  type SocketAuthOptions,
} from "./routes/socketAuth";
export {
  createMemorySessionStore,
  type AuthSession,
  type MemorySessionStore,
  type SessionMeta,
  type SessionStore,
} from "./routes/sessions";
export {
  discord,
  google,
  mock,
  type AuthProfile,
  type MockSignInOptions,
  type MockSignInProvider,
  type OAuthClientOptions,
  type OAuthSignInProvider,
} from "./routes/providers";
export { guest, GUEST_MAX_BODY_BYTES, type GuestOptions, type GuestProvider } from "./routes/guest";
export {
  DEFAULT_SESSION_TTL_MS,
  issueSession,
  liveSession,
  MIN_JWT_SECRET_LENGTH,
  type IssuedSession,
  type SessionKeys,
} from "./routes/tokens";
export { OAUTH_STATE_COOKIE, OAUTH_STATE_TTL_MS } from "./routes/state";
export type { AllowedOrigin } from "./routes/origins";
export type { AuthMiddleware, AuthRateLimits } from "./routes/limits";
export type { AuthRouteRequest, AuthRouteResponse } from "./routes/respond";
