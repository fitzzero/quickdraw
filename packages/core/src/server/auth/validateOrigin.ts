/**
 * Origin validation utility for OAuth redirect and CORS security.
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
   * Allow GitHub Codespace forwarded-port origins
   * (https://{workspace}-{username}-{port}.app.github.dev). Default: true.
   */
  allowCodespaces?: boolean;
  /**
   * Allow http://localhost:* when NODE_ENV !== "production". Default: true.
   */
  allowLocalhostInDev?: boolean;
}

const CODESPACE_REGEX = /^https:\/\/[a-z0-9-]+-[a-z0-9-]+-\d+\.app\.github\.dev$/;
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

  if ((options.allowCodespaces ?? true) && CODESPACE_REGEX.test(cleanOrigin)) {
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
