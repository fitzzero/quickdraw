/**
 * Mock OAuth provider for local development and tests.
 *
 * Implements a real OAuth 2.0 authorization-code flow served by the app's own
 * API, so `createOAuthURL` and `exchangeOAuthCode` work unchanged — the mock
 * is just a provider whose authorize/token/userinfo endpoints the app mounts
 * via `registerMockOAuthProvider`. Users are supplied by the app (typically
 * seeded demo accounts); no real credentials are involved.
 *
 * Production hard-block: routes are never mounted when NODE_ENV is
 * "production" or ENABLE_MOCK_OAUTH !== "true", and every handler re-checks
 * NODE_ENV at request time. Apps should add a third layer and refuse to boot
 * in production with the flag set.
 */

import { randomBytes } from "crypto";
import { consoleLogger, type Logger } from "../../shared/types";
import type { GoogleUser } from "./google";
import type { OAuthProvider } from "./oauth";
import { validateRedirectOrigin } from "./validateOrigin";

export interface MockOAuthUser {
  id: string;
  email: string;
  name: string;
  picture?: string | null;
}

export const DEFAULT_MOCK_PATH_PREFIX = "/auth/mock/provider";

const CODE_TTL_MS = 5 * 60 * 1000;
const TOKEN_TTL_MS = 60 * 60 * 1000;

/** Private-network origins allowed for redirect_uri in dev (LAN testing). */
const DEV_PRIVATE_ORIGIN_REGEX =
  /^http:\/\/(?:localhost|127\.0\.0\.1|0\.0\.0\.0|10\.\d{1,3}\.\d{1,3}\.\d{1,3}|192\.168\.\d{1,3}\.\d{1,3}|172\.(?:1[6-9]|2\d|3[01])\.\d{1,3}\.\d{1,3}):\d+$/;

export function isMockOAuthEnabled(): boolean {
  return process.env.ENABLE_MOCK_OAUTH === "true" && process.env.NODE_ENV !== "production";
}

export interface MockOAuthProviderOptions {
  /**
   * Base URL the API server can use to reach itself for the token/userinfo
   * exchange (server-side fetch). Defaults to apiBaseUrl — override in
   * containers/codespaces where the public URL isn't self-reachable
   * (e.g. "http://localhost:4000").
   */
  internalBaseUrl?: string;
  /** Route prefix for the mock endpoints. Default: "/auth/mock/provider". */
  pathPrefix?: string;
}

/**
 * Create the mock OAuth provider definition.
 *
 * `parseUserInfo` returns a GoogleUser-compatible shape with `id` set to the
 * user's email, so `providerAccountId` stays stable across database re-seeds.
 */
export function createMockOAuthProvider(
  apiBaseUrl: string,
  options: MockOAuthProviderOptions = {},
): OAuthProvider<GoogleUser> {
  const prefix = options.pathPrefix ?? DEFAULT_MOCK_PATH_PREFIX;
  const publicBase = apiBaseUrl.replace(/\/$/, "");
  const internalBase = (options.internalBaseUrl ?? apiBaseUrl).replace(/\/$/, "");

  return {
    name: "mock",
    authorizationUrl: `${publicBase}${prefix}/authorize`,
    tokenUrl: `${internalBase}${prefix}/token`,
    userInfoUrl: `${internalBase}${prefix}/userinfo`,
    scopes: ["openid", "email", "profile"],

    parseUserInfo: (data: unknown): GoogleUser => {
      const d = data as Record<string, unknown>;
      return {
        id: String(d.id),
        email: String(d.email),
        name: String(d.name),
        picture: d.picture ? String(d.picture) : null,
        verified_email: true,
      };
    },
  };
}

interface MockRequest {
  url?: string;
  originalUrl?: string;
  query?: Record<string, unknown>;
  headers: Record<string, string | string[] | undefined>;
  body?: unknown;
}

interface MockResponse {
  status(code: number): MockResponse;
  json(body: unknown): unknown;
  send(body: string): unknown;
  redirect(url: string): unknown;
}

type MockHandler = (req: MockRequest, res: MockResponse) => void | Promise<void>;

export interface MockOAuthRouter {
  get(path: string, handler: MockHandler): unknown;
  post(path: string, handler: MockHandler): unknown;
}

export interface RegisterMockOAuthOptions {
  /**
   * Supply the users shown in the dev login picker (typically seeded demo
   * accounts). Injected so core never touches the app's database.
   */
  listUsers: () => Promise<MockOAuthUser[]>;
  /** Route prefix — must match createMockOAuthProvider's. */
  pathPrefix?: string;
  /**
   * Extra origins allowed for redirect_uri beyond CLIENT_URL /
   * EXTRA_ALLOWED_ORIGINS / localhost / private LAN IPs.
   */
  allowedRedirectOrigins?: string[];
  logger?: Logger;
}

function getQueryParam(req: MockRequest, name: string): string | null {
  const fromQuery = req.query?.[name];
  if (typeof fromQuery === "string") return fromQuery;
  const url = req.originalUrl ?? req.url;
  if (!url) return null;
  const idx = url.indexOf("?");
  if (idx === -1) return null;
  return new URLSearchParams(url.slice(idx + 1)).get(name);
}

/**
 * Parse an x-www-form-urlencoded POST body. Works without any body-parser
 * middleware by falling back to reading the raw request stream. An empty
 * object body is treated as unparsed: express.json() sets req.body = {} even
 * when it skips non-JSON content types, leaving the stream unread.
 */
async function readBodyParams(req: MockRequest): Promise<URLSearchParams> {
  if (typeof req.body === "string") return new URLSearchParams(req.body);
  if (req.body && typeof req.body === "object" && Object.keys(req.body).length > 0) {
    return new URLSearchParams(req.body as Record<string, string>);
  }
  const chunks: Buffer[] = [];
  for await (const chunk of req as unknown as AsyncIterable<Buffer>) {
    chunks.push(Buffer.from(chunk));
  }
  return new URLSearchParams(Buffer.concat(chunks).toString("utf8"));
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function isAllowedRedirectUri(uri: string, allowedOrigins: string[]): boolean {
  let parsed: URL;
  try {
    parsed = new URL(uri);
  } catch {
    return false;
  }
  const origin = parsed.origin;
  if (allowedOrigins.includes(origin)) return true;
  if (DEV_PRIVATE_ORIGIN_REGEX.test(origin)) return true;
  return validateRedirectOrigin(origin) !== null;
}

function renderPickerPage(
  users: MockOAuthUser[],
  authorizePath: string,
  redirectUri: string,
  state: string | null,
): string {
  const links = users
    .map((user) => {
      const params = new URLSearchParams({ redirect_uri: redirectUri, email: user.email });
      if (state) params.set("state", state);
      const href = `${authorizePath}?${params.toString()}`;
      return `<li><a href="${escapeHtml(href)}"><strong>${escapeHtml(user.name)}</strong><span>${escapeHtml(user.email)}</span></a></li>`;
    })
    .join("\n");

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>Mock sign-in</title>
<style>
  body { font-family: system-ui, sans-serif; background: #111; color: #eee; display: flex; min-height: 100vh; align-items: center; justify-content: center; margin: 0; }
  main { max-width: 420px; width: 100%; padding: 2rem; }
  h1 { font-size: 1.25rem; }
  p { color: #999; font-size: 0.875rem; }
  ul { list-style: none; padding: 0; display: flex; flex-direction: column; gap: 0.5rem; }
  a { display: flex; flex-direction: column; gap: 0.125rem; padding: 0.75rem 1rem; border: 1px solid #333; border-radius: 8px; text-decoration: none; color: inherit; }
  a:hover { border-color: #888; background: #1a1a1a; }
  a span { color: #999; font-size: 0.8125rem; }
</style>
</head>
<body>
<main>
<h1>Mock sign-in</h1>
<p>Development only — pick an account to continue. Run your seed script if this list is empty.</p>
<ul>
${links || "<li><em>No users found.</em></li>"}
</ul>
</main>
</body>
</html>`;
}

/**
 * Mount the mock OAuth provider endpoints (authorize, token, userinfo) on an
 * Express-compatible router.
 *
 * No-ops (returning false) unless `isMockOAuthEnabled()` — i.e. in production
 * or without ENABLE_MOCK_OAUTH=true the routes are never mounted.
 */
export function registerMockOAuthProvider(
  router: MockOAuthRouter,
  options: RegisterMockOAuthOptions,
): boolean {
  const logger = options.logger ?? consoleLogger;

  if (!isMockOAuthEnabled()) {
    if (process.env.ENABLE_MOCK_OAUTH === "true") {
      logger.error("Mock OAuth is enabled but NODE_ENV is production — refusing to mount routes");
    }
    return false;
  }

  const prefix = options.pathPrefix ?? DEFAULT_MOCK_PATH_PREFIX;
  const allowedOrigins = options.allowedRedirectOrigins ?? [];

  // Single-use auth codes and bearer tokens, both short-lived and in-memory.
  const codes = new Map<string, { email: string; expiresAt: number }>();
  const tokens = new Map<string, { email: string; expiresAt: number }>();

  function sweep(store: Map<string, { expiresAt: number }>): void {
    const now = Date.now();
    for (const [key, entry] of store) {
      if (entry.expiresAt < now) store.delete(key);
    }
  }

  function guard(res: MockResponse): boolean {
    // Request-time re-check defends against env mutation after boot.
    if (process.env.NODE_ENV === "production") {
      res.status(404).json({ error: "Not found" });
      return false;
    }
    return true;
  }

  router.get(`${prefix}/authorize`, async (req, res) => {
    if (!guard(res)) return;

    const redirectUri = getQueryParam(req, "redirect_uri");
    const state = getQueryParam(req, "state");
    const email = getQueryParam(req, "email");

    if (!redirectUri || !isAllowedRedirectUri(redirectUri, allowedOrigins)) {
      res.status(400).json({ error: "Invalid redirect_uri" });
      return;
    }

    const users = await options.listUsers();

    if (!email) {
      res.status(200).send(renderPickerPage(users, `${prefix}/authorize`, redirectUri, state));
      return;
    }

    const user = users.find((u) => u.email === email);
    if (!user) {
      res.status(400).json({ error: "Unknown mock user" });
      return;
    }

    sweep(codes);
    const code = randomBytes(24).toString("hex");
    codes.set(code, { email: user.email, expiresAt: Date.now() + CODE_TTL_MS });

    const params = new URLSearchParams({ code });
    if (state) params.set("state", state);
    res.redirect(`${redirectUri}${redirectUri.includes("?") ? "&" : "?"}${params.toString()}`);
  });

  router.post(`${prefix}/token`, async (req, res) => {
    if (!guard(res)) return;

    const body = await readBodyParams(req);
    const code = body.get("code");
    const entry = code ? codes.get(code) : undefined;
    if (code) codes.delete(code);

    if (!entry || entry.expiresAt < Date.now()) {
      res.status(400).json({ error: "invalid_grant" });
      return;
    }

    sweep(tokens);
    const accessToken = randomBytes(24).toString("hex");
    tokens.set(accessToken, { email: entry.email, expiresAt: Date.now() + TOKEN_TTL_MS });

    res.status(200).json({
      access_token: accessToken,
      token_type: "Bearer",
      expires_in: Math.floor(TOKEN_TTL_MS / 1000),
      scope: "openid email profile",
    });
  });

  router.get(`${prefix}/userinfo`, async (req, res) => {
    if (!guard(res)) return;

    const auth = req.headers.authorization;
    const accessToken =
      typeof auth === "string" && auth.startsWith("Bearer ") ? auth.slice(7) : null;
    const entry = accessToken ? tokens.get(accessToken) : undefined;

    if (!entry || entry.expiresAt < Date.now()) {
      res.status(401).json({ error: "invalid_token" });
      return;
    }

    const users = await options.listUsers();
    const user = users.find((u) => u.email === entry.email);
    if (!user) {
      res.status(401).json({ error: "invalid_token" });
      return;
    }

    res.status(200).json({
      // providerAccountId = email: stable across re-seeds, unlike row ids.
      id: user.email,
      email: user.email,
      name: user.name,
      picture: user.picture ?? null,
      verified_email: true,
    });
  });

  logger.info(`Mock OAuth provider mounted at ${prefix} (development only)`);
  return true;
}
