const AUTH_TOKEN_KEY = "auth_token";

/**
 * Get the stored auth token from localStorage.
 */
export function getAuthToken(): string | null {
  if (typeof window === "undefined") return null;
  return localStorage.getItem(AUTH_TOKEN_KEY);
}

/**
 * Store the auth token in localStorage and dispatch a change event.
 */
export function setAuthToken(token: string): void {
  if (typeof window === "undefined") return;
  localStorage.setItem(AUTH_TOKEN_KEY, token);
  window.dispatchEvent(new Event("auth-token-changed"));
}

/**
 * Remove the auth token from localStorage and dispatch a change event.
 */
export function clearAuthToken(): void {
  if (typeof window === "undefined") return;
  localStorage.removeItem(AUTH_TOKEN_KEY);
  window.dispatchEvent(new Event("auth-token-changed"));
}

export interface JWTPayload {
  userId: string;
  email?: string;
}

/**
 * Parse JWT payload client-side (not verified, for display purposes only).
 */
export function parseJWTPayload(token: string): JWTPayload | null {
  try {
    const parts = token.split(".");
    if (parts.length !== 3 || !parts[1]) return null;

    const decoded = atob(parts[1]);
    const payload: unknown = JSON.parse(decoded);

    if (
      typeof payload === "object" &&
      payload !== null &&
      "userId" in payload &&
      typeof (payload as { userId: unknown }).userId === "string"
    ) {
      const typedPayload = payload as { userId: string; email?: string };
      return {
        userId: typedPayload.userId,
        email: typedPayload.email,
      };
    }
    return null;
  } catch {
    return null;
  }
}

/**
 * Build an OAuth redirect URL for a given provider.
 */
export function getOAuthUrl(provider: string, apiUrl?: string): string {
  const base = apiUrl ?? process.env.NEXT_PUBLIC_API_URL ?? "http://localhost:4000";
  return `${base}/auth/${provider}`;
}

/**
 * Logout from current session (invalidate token on server and clear localStorage).
 */
export async function logout(apiUrl?: string): Promise<void> {
  const base = apiUrl ?? process.env.NEXT_PUBLIC_API_URL ?? "http://localhost:4000";
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
 * Logout from all devices (invalidate all sessions and clear localStorage).
 * Returns the number of sessions invalidated.
 */
export async function logoutAllDevices(apiUrl?: string): Promise<number> {
  const base = apiUrl ?? process.env.NEXT_PUBLIC_API_URL ?? "http://localhost:4000";
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
