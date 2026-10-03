// The rate limits on the auth routes (RFC 0003 section 12.6). By default the
// sign-in routes (each provider's start and callback, and the guest route)
// share `createAuthLimiter({ max: SIGN_IN_LIMIT })` (60 requests per 15
// minutes per IP: a start and a callback per sign-in, and a shared office or
// school address, use 4.1's 20 up quickly) and the session routes (`me`,
// `logout`, `logout-all`) share `createAuthStatusLimiter` (120). Both
// presets live in `./server/express`,
// which needs the optional peer `express-rate-limit`; the routes import them
// only when a default is used, so importing `./server/auth` for its JWT
// helpers alone does not need the peer.

/** How many sign-in requests one IP may make per 15 minutes under the default limiter. */
export const SIGN_IN_LIMIT = 60;

/** An Express middleware, such as an `express-rate-limit` limiter: it answers the request, or calls `next()`. */
export type AuthMiddleware = (req: never, res: never, next: (error?: unknown) => void) => unknown;

/** The limiters of the auth routes. Each one left out gets its default. */
export interface AuthRateLimits {
  /**
   * Each provider's start and callback, and the guest route. Default:
   * `createAuthLimiter({ max: 60 })`, 60 requests per 15 minutes per IP.
   */
  readonly signIn?: AuthMiddleware;
  /** `me`, `logout` and `logout-all`. Default: `createAuthStatusLimiter()`. */
  readonly session?: AuthMiddleware;
}

/** Which limiter a route is counted by. */
export type LimitKind = keyof AuthRateLimits;

/** The limiters in use; none with `rateLimit: false`. */
export type Limiters = Readonly<Partial<Record<LimitKind, AuthMiddleware>>>;

/** Throws a `TypeError` unless `option` is `false`, absent, or limiters that are functions. */
export function checkRateLimits(option: unknown): AuthRateLimits | false {
  if (option === false) {
    return false;
  }
  if (option === undefined) {
    return {};
  }
  if (typeof option !== "object" || option === null) {
    throw new TypeError("createAuthRoutes: rateLimit must be { signIn?, session? } or false");
  }
  for (const [name, limiter] of Object.entries(option)) {
    if (limiter !== undefined && typeof limiter !== "function") {
      throw new TypeError(`createAuthRoutes: rateLimit.${name} must be an Express middleware`);
    }
  }
  return option as AuthRateLimits;
}

/**
 * The limiters the routes use: the app's, and the default presets for the
 * ones it left out. Rejects when a preset is needed and `express-rate-limit`
 * is not installed.
 */
export async function loadLimiters(option: AuthRateLimits | false): Promise<Limiters> {
  if (option === false) {
    return {};
  }
  if (option.signIn !== undefined && option.session !== undefined) {
    return option;
  }
  const presets = await import("../../express/rateLimit");
  return {
    signIn: option.signIn ?? presets.createAuthLimiter({ max: SIGN_IN_LIMIT }),
    session: option.session ?? presets.createAuthStatusLimiter(),
  };
}
