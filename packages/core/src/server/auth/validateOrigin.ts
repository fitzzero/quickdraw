/**
 * Origin validation utility for OAuth redirect and CORS security.
 *
 * An origin is allowed when it is the client URL, one of the extra origins
 * or matches an app's pattern, or, outside production, is localhost. GitHub
 * Codespaces origins (`*.app.github.dev`) are never allowed by default since
 * 5.0.1 (finding R1.2 of the 5.0.0 review): anyone can open a Codespace, so
 * the allowance let any such page open a socket or finish a sign-in as a
 * signed-in user in production, wherever an app used this helper for CORS or
 * a cookie check. An app that wants one lists a pattern in `allowedPatterns`.
 */

export const OAUTH_RETURN_ORIGIN_COOKIE = "oauth_return_origin";

export interface ValidateOriginOptions {
  /**
   * The primary web client origin. Defaults to process.env.CLIENT_URL.
   */
  clientUrl?: string;
  /**
   * Additional exact-match origins. Defaults to the comma-separated
   * process.env.EXTRA_ALLOWED_ORIGINS. Lets a single API back multiple web
   * hosts (e.g. prod + staging).
   */
  extraAllowedOrigins?: string[];
  /**
   * App-specific origin patterns (e.g. preview-deploy subdomains).
   */
  allowedPatterns?: RegExp[];
  /**
   * Ignored: kept so 5.0.0 code that passes it still compiles.
   *
   * @deprecated Codespaces origins are never allowed since 5.0.1; list a pattern in allowedPatterns if one is wanted.
   */
  allowCodespaces?: boolean;
  /**
   * Allow http://localhost:* when NODE_ENV !== "production". Default: true.
   */
  allowLocalhostInDev?: boolean;
}

const LOCALHOST_REGEX = /^http:\/\/localhost:\d+$/;

function envExtraOrigins(): string[] {
  const raw = process.env.EXTRA_ALLOWED_ORIGINS;
  if (!raw) return [];
  return raw
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
}

/**
 * Validates if an origin is safe for OAuth redirect / CORS.
 *
 * Only the origin (scheme + host + port) is compared, never the path, to
 * prevent path-injection bypasses.
 *
 * @param origin - The origin to validate
 * @param options - Override env-derived defaults
 * @returns The validated origin if allowed, null otherwise
 */
export function validateRedirectOrigin(
  origin: string,
  options: ValidateOriginOptions = {},
): string | null {
  if (!origin) return null;

  const clientUrl = options.clientUrl ?? process.env.CLIENT_URL;

  let parsedOrigin: URL;
  try {
    parsedOrigin = new URL(origin);
  } catch {
    return null;
  }

  const cleanOrigin = parsedOrigin.origin;

  if (clientUrl && cleanOrigin === clientUrl) {
    return cleanOrigin;
  }

  const extra = options.extraAllowedOrigins ?? envExtraOrigins();
  if (extra.includes(cleanOrigin)) {
    return cleanOrigin;
  }

  if (options.allowedPatterns?.some((pattern) => pattern.test(cleanOrigin))) {
    return cleanOrigin;
  }

  if (
    (options.allowLocalhostInDev ?? true) &&
    process.env.NODE_ENV !== "production" &&
    LOCALHOST_REGEX.test(cleanOrigin)
  ) {
    return cleanOrigin;
  }

  return null;
}
