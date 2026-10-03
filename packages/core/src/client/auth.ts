// Token storage and logout helpers, carried over from 4.1
// (`legacy-src/client/utils/auth.ts`). They keep the token in
// `localStorage`, so they stay on `./client`; `parseJWTPayload`, which needs
// no storage, moved to the isomorphic `./utils` entry (`../utils/jwt.ts`).
//
// 4.1 assumed a browser wherever `window` exists. React Native defines
// `window` without `localStorage`, and a browser with storage turned off
// throws when it is used; there the token is kept in memory for the life of
// the app. Without `window` (a server rendering a page) nothing is kept, so
// one request's token never reaches another. The API's URL defaults to
// `NEXT_PUBLIC_API_URL` where `process.env` can be read (Next.js inlines it
// when it builds a page), and to `http://localhost:4000` elsewhere.

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

/**
 * Build an OAuth redirect URL for a given provider.
 */
export function getOAuthUrl(provider: string, apiUrl?: string): string {
  return `${apiUrlOf(apiUrl)}/auth/${provider}`;
}

/**
 * Logout from current session (invalidate token on server and clear the stored token).
 */
export async function logout(apiUrl?: string): Promise<void> {
  const base = apiUrlOf(apiUrl);
  const token = getAuthToken();

  if (token) {
    try {
      await fetch(`${base}/auth/logout`, {
        method: "DELETE",
        headers: { Authorization: `Bearer ${token}` },
      });
    } catch {
      // Clear local token regardless of network errors
    }
  }

  clearAuthToken();
}

/**
 * Logout from all devices (invalidate all sessions and clear the stored token).
 * Returns the number of sessions invalidated.
 */
export async function logoutAllDevices(apiUrl?: string): Promise<number> {
  const base = apiUrlOf(apiUrl);
  const token = getAuthToken();

  if (!token) {
    clearAuthToken();
    return 0;
  }

  try {
    const response = await fetch(`${base}/auth/sessions`, {
      method: "DELETE",
      headers: { Authorization: `Bearer ${token}` },
    });

    if (response.ok) {
      const data = (await response.json()) as {
        sessionsDeleted?: number;
      };
      clearAuthToken();
      return data.sessionsDeleted ?? 0;
    }
  } catch {
    // Clear local token regardless of network errors
  }

  clearAuthToken();
  return 0;
}
