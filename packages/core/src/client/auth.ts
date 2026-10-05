// The browser side of the auth routes kit (RFC 0003 section 12.6), and
// token storage. `authProviders`, `signInUrl`, `signOut` and
// `signOutEverywhere` use the routes `createAuthRoutes` serves (`GET
// {basePath}/providers`, `GET {basePath}/{provider}/start`, `POST
// {basePath}/logout`, `POST {basePath}/logout-all`); the last three replace
// 4.1's `getOAuthUrl`, `logout` and `logoutAllDevices`
// (4.1 `src/client/utils/auth.ts`), which called routes the kit does not
// serve and sent only a stored token, so with cookie sessions they signed
// nobody out (finding F3.3). The token helpers keep a bearer token for
// clients without cookies; they read `localStorage`, so they stay on
// `./client`; `parseJWTPayload`, which needs no storage, moved to the
// isomorphic `./utils` entry (`../utils/jwt.ts`).
//
// A POST sends the session cookie (`credentials: "include"`: the API is
// often on another origin, whose CORS must then allow the web app's origin
// with credentials) and `Content-Type: application/json`, which the routes
// require (a cross-site form cannot send it), and the stored token as a
// bearer token when there is one. A refusal or an unreachable server
// rejects with a `QuickdrawError`: nothing fails silently.
//
// 4.1 assumed a browser wherever `window` exists. React Native defines
// `window` without `localStorage`, and a browser with storage turned off
// throws when it is used; there the token is kept in memory for the life of
// the app. Without `window` (a server rendering a page) nothing is kept, so
// one request's token never reaches another. The API's URL defaults to
// `NEXT_PUBLIC_API_URL` where `process.env` can be read (Next.js inlines it
// when it builds a page), and to `http://localhost:4000` elsewhere.

import { QuickdrawError, isErrorCode } from "../protocol/errors";
import { isRecord } from "../protocol/guards";

const AUTH_TOKEN_KEY = "auth_token";

const DEFAULT_API_URL = "http://localhost:4000";

/** The token, where `localStorage` cannot be used. */
let memoryToken: string | null = null;

/** True where a client keeps a token: there is a `window` (a browser, React Native). */
function onClient(): boolean {
  return typeof window !== "undefined";
}

/** The token `localStorage` holds; `undefined` when there is no `localStorage` to use. */
function storedToken(): string | null | undefined {
  try {
    return globalThis.localStorage.getItem(AUTH_TOKEN_KEY);
  } catch {
    return undefined;
  }
}

/** Tells the page the token changed, where there is a page to tell. */
function announce(): void {
  if (typeof window.dispatchEvent === "function" && typeof Event === "function") {
    window.dispatchEvent(new Event("auth-token-changed"));
  }
}

/** The API's URL: `apiUrl`, else `NEXT_PUBLIC_API_URL` where `process.env` can be read, else localhost. */
function apiUrlOf(apiUrl: string | undefined): string {
  if (apiUrl !== undefined) {
    return apiUrl;
  }
  try {
    // Written out whole, so Next.js can inline it when it builds a page.
    return process.env.NEXT_PUBLIC_API_URL ?? DEFAULT_API_URL;
  } catch {
    // No `process` here (React Native, a bundler that provides none).
    return DEFAULT_API_URL;
  }
}

/**
 * Get the stored auth token: from `localStorage`, or from memory where it
 * cannot be used; `null` without a `window`.
 */
export function getAuthToken(): string | null {
  if (!onClient()) return null;
  const stored = storedToken();
  return stored === undefined ? memoryToken : stored;
}

/**
 * Store the auth token (in `localStorage`, else in memory) and dispatch a
 * change event. Does nothing without a `window`.
 */
export function setAuthToken(token: string): void {
  if (!onClient()) return;
  memoryToken = token;
  try {
    globalThis.localStorage.setItem(AUTH_TOKEN_KEY, token);
  } catch {
    // No usable localStorage: the token is kept in memory.
  }
  announce();
}

/**
 * Remove the auth token and dispatch a change event. Does nothing without a
 * `window`.
 */
export function clearAuthToken(): void {
  if (!onClient()) return;
  memoryToken = null;
  try {
    globalThis.localStorage.removeItem(AUTH_TOKEN_KEY);
  } catch {
    // No usable localStorage: forgetting the token in memory is enough.
  }
  announce();
}

/** Where the auth routes are, for the browser helpers. */
export interface AuthRoutesTarget {
  /**
   * The API's URL, where `createAuthRoutes` is mounted:
   * `"https://api.example.com"`. Default: `NEXT_PUBLIC_API_URL` where it can
   * be read, else `http://localhost:4000`.
   */
  readonly apiUrl?: string;
  /** The routes' `basePath`, as `createAuthRoutes` was given it. Default `/auth`. */
  readonly basePath?: string;
}

/** Options of {@link signInUrl}. */
export interface SignInUrlOptions extends AuthRoutesTarget {
  /**
   * The page to come back to: an origin or a URL on one, of which the
   * routes keep the origin when `allowedOrigins` lists it, and land on
   * `{origin}{successPath}`. Default: the current page's origin where there
   * is a page; elsewhere the routes take their first allowed origin.
   */
  readonly returnTo?: string;
}

const PROVIDER_ID = /^[a-z0-9][a-z0-9-]*$/;

/** The routes' base URL: `{apiUrl}{basePath}`, checked. */
function routesUrl(owner: string, target: AuthRoutesTarget): string {
  const base = apiUrlOf(target.apiUrl).replace(/\/+$/, "");
  const path = target.basePath ?? "/auth";
  if (typeof path !== "string" || !path.startsWith("/")) {
    throw new TypeError(`${owner}: basePath must start with "/", as createAuthRoutes takes it`);
  }
  return `${base}${path.replace(/\/+$/, "")}`;
}

/** The current page's origin, where there is a page. */
function pageOrigin(): string | undefined {
  try {
    const origin: unknown = (globalThis as { readonly location?: { readonly origin?: unknown } })
      .location?.origin;
    return typeof origin === "string" && origin !== "null" ? origin : undefined;
  } catch {
    return undefined;
  }
}

/**
 * The URL that starts a sign-in with `provider`: the auth routes' `GET
 * {basePath}/{provider}/start?returnTo=`, which redirects to the provider
 * and, once the user consents, back to `returnTo`'s origin with the session
 * cookie set (or to the routes' `errorPath` with `?error=`). Navigate to it:
 * a link, or `location.assign`. Throws a `TypeError` for a provider id the
 * routes cannot have (lowercase letters, digits and hyphens).
 *
 * @example
 * <a href={signInUrl("google", { apiUrl: API_URL })}>Sign in with Google</a>
 */
export function signInUrl(provider: string, options: SignInUrlOptions = {}): string {
  if (typeof provider !== "string" || !PROVIDER_ID.test(provider)) {
    throw new TypeError(
      `signInUrl: a provider id is lowercase letters, digits and hyphens; got ${String(provider)}`,
    );
  }
  const url = new URL(`${routesUrl("signInUrl", options)}/${provider}/start`);
  const returnTo = options.returnTo ?? pageOrigin();
  if (returnTo !== undefined) {
    url.searchParams.set("returnTo", returnTo);
  }
  return url.toString();
}

/** The error a route's refusal stands for: its `{ error, message }` body, else its HTTP status. */
async function refusalOf(response: Response): Promise<QuickdrawError> {
  let body: unknown;
  try {
    body = await response.json();
  } catch {
    body = undefined;
  }
  const code = isRecord(body) && isErrorCode(body.error) ? body.error : undefined;
  const message =
    isRecord(body) && typeof body.message === "string"
      ? body.message
      : `The auth route answered ${String(response.status)}`;
  if (code !== undefined) {
    return new QuickdrawError(code, message);
  }
  return new QuickdrawError(response.status === 429 ? "RATE_LIMITED" : "INTERNAL", message);
}

/** POSTs to one session route with the cookie, the JSON content type and the stored token. */
async function postRoute(owner: string, route: string, target: AuthRoutesTarget): Promise<void> {
  const url = `${routesUrl(owner, target)}${route}`;
  const token = getAuthToken();
  let response: Response;
  try {
    response = await fetch(url, {
      method: "POST",
      credentials: "include",
      headers: {
        "Content-Type": "application/json",
        ...(token === null ? {} : { Authorization: `Bearer ${token}` }),
      },
      body: "{}",
    });
  } catch (error) {
    throw new QuickdrawError("INTERNAL", `${owner}: ${url} could not be reached`, {
      cause: error instanceof Error ? error.message : String(error),
    });
  }
  if (!response.ok) {
    throw await refusalOf(response);
  }
}

/**
 * Signs out: `POST {basePath}/logout`, which revokes the request's session
 * and clears its cookie, sent with the session cookie and, when one is
 * stored, the bearer token; the stored token is forgotten either way.
 * Rejects with a `QuickdrawError` when the server cannot be reached or
 * refuses (`RATE_LIMITED`, say), so the app knows the session may still be
 * live. The connection keeps the user it signed in as until it connects
 * again: with cookie sessions, reconnect it (`connection.close()`, then
 * `open()`), or load the next page; a provider whose `auth` was the stored
 * token reconnects when the app clears it.
 *
 * @example
 * await signOut({ apiUrl: API_URL });
 */
export async function signOut(options: AuthRoutesTarget = {}): Promise<void> {
  try {
    await postRoute("signOut", "/logout", options);
  } finally {
    clearAuthToken();
  }
}

/** A sign-in the API's auth routes serve, as `GET {basePath}/providers` lists it ({@link authProviders}). */
export interface AuthProviderInfo {
  /** Its id: `signInUrl(id)` starts it; a guest's is `POST {basePath}/guest`. */
  readonly id: string;
  /** A name for its button: `"Google"`, `"Discord"`, `"Mock"`, `"Guest"`, or an OAuth provider's own. */
  readonly name: string;
  /** `"oauth"` (a redirecting provider), `"mock"` (the development picker) or `"guest"`. */
  readonly kind: "oauth" | "mock" | "guest";
}

const PROVIDER_KINDS: ReadonlySet<unknown> = new Set(["oauth", "mock", "guest"]);

/** One entry of the routes' list, its known fields only (a newer server may add others). */
function providerInfoOf(value: unknown): AuthProviderInfo | undefined {
  if (!isRecord(value) || typeof value.id !== "string" || !PROVIDER_ID.test(value.id)) {
    return undefined;
  }
  const kind = PROVIDER_KINDS.has(value.kind)
    ? (value.kind as AuthProviderInfo["kind"])
    : undefined;
  return kind === undefined
    ? undefined
    : { id: value.id, name: typeof value.name === "string" ? value.name : value.id, kind };
}

/**
 * The sign-ins the API serves, in the order its routes list them: `GET
 * {basePath}/providers` (finding F9.1 of the owner's QA of the template), so
 * a login page renders a button only for a provider that is there, whatever
 * the web app was built with: a provider whose credentials the server lacks
 * is not listed, nor the mock where it is off. Rejects with a
 * `QuickdrawError` when the server cannot be reached or refuses.
 *
 * @example
 * const { data: providers = [] } = useQuery({
 *   queryKey: ["auth", "providers"],
 *   queryFn: () => authProviders({ apiUrl: API_URL }),
 * });
 */
export async function authProviders(
  options: AuthRoutesTarget = {},
): Promise<readonly AuthProviderInfo[]> {
  const url = `${routesUrl("authProviders", options)}/providers`;
  let response: Response;
  try {
    response = await fetch(url, { headers: { Accept: "application/json" } });
  } catch (error) {
    throw new QuickdrawError("INTERNAL", `authProviders: ${url} could not be reached`, {
      cause: error instanceof Error ? error.message : String(error),
    });
  }
  if (!response.ok) {
    throw await refusalOf(response);
  }
  let body: unknown;
  try {
    body = await response.json();
  } catch {
    body = undefined;
  }
  if (!isRecord(body) || !Array.isArray(body.providers)) {
    throw new QuickdrawError("INTERNAL", `authProviders: ${url} answered no list of providers`);
  }
  return body.providers.flatMap((entry: unknown) => {
    const info = providerInfoOf(entry);
    return info === undefined ? [] : [info];
  });
}

/**
 * Signs the user out everywhere: `POST {basePath}/logout-all`, which
 * revokes every session of the user (the app's `onRevoke` can disconnect
 * their sockets) and clears this browser's cookie; the stored token is
 * forgotten either way. Rejects with `UNAUTHENTICATED` when the request
 * carries no live session, and with a `QuickdrawError` when the server
 * cannot be reached or refuses.
 */
export async function signOutEverywhere(options: AuthRoutesTarget = {}): Promise<void> {
  try {
    await postRoute("signOutEverywhere", "/logout-all", options);
  } finally {
    clearAuthToken();
  }
}
