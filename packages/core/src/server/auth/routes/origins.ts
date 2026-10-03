// The browser origins the auth kit trusts (RFC 0003 section 12.6): where a
// sign-in may return to, and which pages may open a socket with the session
// cookie. One list serves both. `validateRedirectOrigin` decides, with each
// of its defaults turned off: no CLIENT_URL or EXTRA_ALLOWED_ORIGINS from the
// environment, no GitHub Codespaces origins, no implicit localhost. The
// list the app passes is the whole allowlist.

import { validateRedirectOrigin, type ValidateOriginOptions } from "../validateOrigin";

/**
 * An allowed origin: exact (`"https://app.example.com"`), or a pattern over
 * whole origins, anchored at both ends
 * (`/^https:\/\/[a-z0-9-]+\.preview\.example\.com$/`).
 */
export type AllowedOrigin = string | RegExp;

/** The allowlist, checked and normalized. */
export interface OriginAllowlist {
  /** The origin of `value` (an origin or a URL) when it is allowed, else `null`. */
  allowed(value: string | undefined): string | null;
  /** The first exact origin listed: where a sign-in returns when it names none. */
  readonly fallback: string | undefined;
}

function exactOrigin(entry: unknown, owner: string): string {
  let url: URL | undefined;
  try {
    url = typeof entry === "string" ? new URL(entry) : undefined;
  } catch {
    url = undefined;
  }
  const bare =
    url !== undefined &&
    (url.protocol === "https:" || url.protocol === "http:") &&
    url.username === "" &&
    url.password === "" &&
    url.pathname === "/" &&
    url.search === "" &&
    url.hash === "";
  if (url === undefined || !bare) {
    throw new TypeError(
      `${owner}: allowedOrigins entries are origins such as "https://app.example.com" or anchored patterns; got ${String(entry)}`,
    );
  }
  return url.origin;
}

/**
 * The pattern, refused unless it is written anchored with `^` and `$`, and
 * compiled to match whole origins whatever it holds: `^a|b$` is anchored
 * only at its ends (`^a` or `b$`), so `/^https:\/\/app|staging\.example\.com$/`
 * would allow `https://app.attacker.net`. The source is wrapped as
 * `^(?:source)$`, so every alternative must match the whole origin.
 */
function anchoredPattern(pattern: RegExp, owner: string): RegExp {
  const { source } = pattern;
  const anchored = source.startsWith("^") && source.endsWith("$") && !source.endsWith("\\$");
  if (!anchored || pattern.global || pattern.sticky) {
    throw new TypeError(
      `${owner}: an allowedOrigins pattern must match whole origins, anchored with ^ and $ and without the g or y flag; got ${String(pattern)}`,
    );
  }
  return new RegExp(`^(?:${source})$`, pattern.flags);
}

/**
 * Checks and normalizes an allowlist; throws a `TypeError` naming `owner`
 * for an entry that is neither an origin nor an anchored pattern, or for an
 * empty list unless `allowEmpty`.
 */
export function originAllowlist(
  allowedOrigins: readonly AllowedOrigin[],
  owner: string,
  allowEmpty = false,
): OriginAllowlist {
  if (!Array.isArray(allowedOrigins) || (allowedOrigins.length === 0 && !allowEmpty)) {
    throw new TypeError(`${owner}: allowedOrigins must list the web app's origins`);
  }
  const exact: string[] = [];
  const patterns: RegExp[] = [];
  for (const entry of allowedOrigins) {
    if (entry instanceof RegExp) {
      patterns.push(anchoredPattern(entry, owner));
    } else {
      exact.push(exactOrigin(entry, owner));
    }
  }
  const options: ValidateOriginOptions = {
    // An empty client URL, not undefined: undefined falls back to process.env.CLIENT_URL.
    clientUrl: "",
    extraAllowedOrigins: exact,
    allowedPatterns: patterns,
    allowCodespaces: false,
    allowLocalhostInDev: false,
  };
  return Object.freeze({
    allowed: (value: string | undefined) =>
      typeof value === "string" && value !== "" ? validateRedirectOrigin(value, options) : null,
    fallback: exact[0],
  });
}
