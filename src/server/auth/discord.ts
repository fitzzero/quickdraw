import type { OAuthProvider } from "./oauth";

/**
 * Discord user information.
 */
export interface DiscordUser {
  id: string;
  username: string;
  discriminator: string;
  email: string | null;
  avatar: string | null;
  verified: boolean;
}

/**
 * Discord OAuth provider configuration.
 */
export const discordProvider: OAuthProvider<DiscordUser> = {
  name: "discord",
  authorizationUrl: "https://discord.com/api/oauth2/authorize",
  tokenUrl: "https://discord.com/api/oauth2/token",
  userInfoUrl: "https://discord.com/api/users/@me",
  scopes: ["identify", "email"],

  parseUserInfo: (data: unknown): DiscordUser => {
    const d = data as Record<string, unknown>;
    return {
      id: String(d.id),
      username: String(d.username),
      discriminator: String(d.discriminator ?? "0"),
      email: d.email ? String(d.email) : null,
      avatar: d.avatar ? String(d.avatar) : null,
      verified: Boolean(d.verified),
    };
  },
};

/**
 * Get Discord avatar URL.
 */
export function getDiscordAvatarUrl(user: DiscordUser): string {
  if (user.avatar) {
    return `https://cdn.discordapp.com/avatars/${user.id}/${user.avatar}.png`;
  }
  // Default avatar based on discriminator or user ID
  const index =
    user.discriminator !== "0"
      ? parseInt(user.discriminator, 10) % 5
      : (BigInt(user.id) >> BigInt(22)) % BigInt(6);
  return `https://cdn.discordapp.com/embed/avatars/${index}.png`;
}
