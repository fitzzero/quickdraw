// Auth utilities for @quickdraw/core/server

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
