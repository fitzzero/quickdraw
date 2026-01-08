import type { OAuthProvider } from "./oauth";

/**
 * Google user information.
 */
export interface GoogleUser {
  id: string;
  email: string;
  name: string;
  picture: string | null;
  verified_email: boolean;
}

/**
 * Google OAuth provider configuration.
 */
export const googleProvider: OAuthProvider<GoogleUser> = {
  name: "google",
  authorizationUrl: "https://accounts.google.com/o/oauth2/v2/auth",
  tokenUrl: "https://oauth2.googleapis.com/token",
  userInfoUrl: "https://www.googleapis.com/oauth2/v2/userinfo",
  scopes: ["openid", "email", "profile"],

  parseUserInfo: (data: unknown): GoogleUser => {
    const d = data as Record<string, unknown>;
    return {
      id: String(d.id),
      email: String(d.email),
      name: String(d.name),
      picture: d.picture ? String(d.picture) : null,
      verified_email: Boolean(d.verified_email),
    };
  },
};
