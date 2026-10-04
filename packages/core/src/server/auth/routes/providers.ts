// The sign-in providers of the auth routes kit (RFC 0003 section 12.6): the
// 4.1 Google and Discord providers and the development mock, each wrapped
// into one shape, `{ id, authorizeUrl(state, redirectUri), profile(code,
// redirectUri) }`, that the routes drive the same way. An app adds another
// OAuth provider by writing that shape itself. The mock provider is served by
// the routes themselves, and only while `isMockOAuthEnabled()`; the guest
// provider is in `guest.ts`.

import { discordProvider, getDiscordAvatarUrl } from "../discord";
import { googleProvider } from "../google";
import type { MockOAuthUser } from "../mock";
import {
  createOAuthURL,
  exchangeOAuthCode,
  type OAuthConfig,
  type OAuthProvider,
  type OAuthTokenResponse,
} from "../oauth";

/** Who signed in, as every provider reports it to `onLogin`. */
export interface AuthProfile {
  /** The provider's id for the user: Google's and Discord's user id, the mock user's email. */
  readonly providerAccountId: string;
  readonly email: string | null;
  /** Whether the provider verified `email`. Link accounts by email only when it did. */
  readonly emailVerified: boolean;
  readonly name: string | null;
  /** An avatar URL. */
  readonly image: string | null;
  /** The provider's tokens, for an app that calls the provider's API later; encrypt them at rest. */
  readonly tokens: OAuthTokenResponse;
  /** The provider's user info as the 4.1 helper parsed it (`GoogleUser`, `DiscordUser`). */
  readonly raw: unknown;
}

/** An OAuth 2.0 authorization-code provider the routes can drive. */
export interface OAuthSignInProvider {
  readonly kind: "oauth";
  /** The provider's id: `{basePath}/{id}/start` and `{basePath}/{id}/callback`. */
  readonly id: string;
  /** The provider's authorization URL for a sign-in with this `state`. */
  authorizeUrl(state: string, redirectUri: string): string;
  /** Exchanges the callback's `code` and reads the user's profile. */
  profile(code: string, redirectUri: string): Promise<AuthProfile>;
}

/** Client credentials and options of a hosted OAuth provider. */
export interface OAuthClientOptions {
  readonly clientId: string;
  readonly clientSecret: string;
  /** The scopes asked for. Default: the 4.1 provider's (`openid email profile`; `identify email`). */
  readonly scopes?: readonly string[];
  /** Extra authorization parameters, such as `{ access_type: "offline", prompt: "consent" }`. */
  readonly params?: Readonly<Record<string, string>>;
}

/** `google.optional` and `discord.optional`'s options: credentials that may be unset, as read from the environment. */
export type OptionalClientOptions = Omit<OAuthClientOptions, "clientId" | "clientSecret"> & {
  readonly clientId: string | undefined;
  readonly clientSecret: string | undefined;
};

/** The development mock provider's options. */
export interface MockSignInOptions {
  /** The users the sign-in picker offers (typically seeded demo accounts). */
  readonly listUsers: () => Promise<MockOAuthUser[]>;
  /**
   * Where the API reaches itself for the token and userinfo requests.
   * Default: `createAuthRoutes`' `publicUrl`; set it where the public URL is
   * not reachable from inside the server (containers, Codespaces), for
   * example `"http://localhost:4000"`.
   */
  readonly internalUrl?: string;
}

/** The development mock provider: the routes serve its endpoints while `isMockOAuthEnabled()`. */
export interface MockSignInProvider {
  readonly kind: "mock";
  readonly id: "mock";
  readonly options: MockSignInOptions;
}

function checkCredentials(options: OAuthClientOptions, owner: string): void {
  if (typeof options.clientId !== "string" || options.clientId === "") {
    throw new TypeError(`${owner}: clientId is required`);
  }
  if (typeof options.clientSecret !== "string" || options.clientSecret === "") {
    throw new TypeError(`${owner}: clientSecret is required`);
  }
}

/** The 4.1 provider with the app's scopes, and the URL and exchange config for one redirect URI. */
function hosted<TUser>(
  base: OAuthProvider<TUser>,
  options: OAuthClientOptions,
): {
  readonly provider: OAuthProvider<TUser>;
  url(state: string, redirectUri: string): string;
  config(redirectUri: string): OAuthConfig;
} {
  const provider = options.scopes === undefined ? base : { ...base, scopes: [...options.scopes] };
  const config = (redirectUri: string): OAuthConfig => ({
    clientId: options.clientId,
    clientSecret: options.clientSecret,
    redirectUri,
  });
  return {
    provider,
    config,
    url: (state, redirectUri) => {
      const url = new URL(createOAuthURL(provider, config(redirectUri), state));
      for (const [name, value] of Object.entries(options.params ?? {})) {
        url.searchParams.set(name, value);
      }
      return url.href;
    },
  };
}

/**
 * The provider `make` builds when both credentials are set; `undefined`,
 * which `createAuthRoutes` skips, when neither is. Only one of the two is a
 * misconfiguration, refused as `make` refuses it.
 */
function optionalOf(
  make: (options: OAuthClientOptions) => OAuthSignInProvider,
): (options: OptionalClientOptions) => OAuthSignInProvider | undefined {
  return (options) => {
    const set = (value: unknown): boolean => typeof value === "string" && value !== "";
    if (!set(options.clientId) && !set(options.clientSecret)) {
      return undefined;
    }
    return make(options as OAuthClientOptions);
  };
}

/** Google sign-in. Register `{publicUrl}{basePath}/google/callback` as a redirect URI. */
export function google(options: OAuthClientOptions): OAuthSignInProvider {
  checkCredentials(options, "google()");
  const client = hosted(googleProvider, options);
  return Object.freeze({
    kind: "oauth",
    id: "google",
    authorizeUrl: client.url,
    async profile(code: string, redirectUri: string): Promise<AuthProfile> {
      const { tokens, user } = await exchangeOAuthCode(
        client.provider,
        client.config(redirectUri),
        code,
      );
      return {
        providerAccountId: user.id,
        email: user.email,
        emailVerified: user.verified_email,
        name: user.name,
        image: user.picture,
        tokens,
        raw: user,
      };
    },
  });
}

/**
 * Google sign-in when both credentials are set, else nothing (`undefined`,
 * which `createAuthRoutes` skips): the provider of an environment that may
 * not configure it, such as development without a Google app.
 *
 * @example
 * providers: [
 *   google.optional({ clientId: env.GOOGLE_CLIENT_ID, clientSecret: env.GOOGLE_CLIENT_SECRET }),
 *   discord.optional({ clientId: env.DISCORD_CLIENT_ID, clientSecret: env.DISCORD_CLIENT_SECRET }),
 *   mock({ listUsers }),
 * ],
 */
google.optional = optionalOf(google);

/** Discord sign-in. Register `{publicUrl}{basePath}/discord/callback` as a redirect URI. */
export function discord(options: OAuthClientOptions): OAuthSignInProvider {
  checkCredentials(options, "discord()");
  const client = hosted(discordProvider, options);
  return Object.freeze({
    kind: "oauth",
    id: "discord",
    authorizeUrl: client.url,
    async profile(code: string, redirectUri: string): Promise<AuthProfile> {
      const { tokens, user } = await exchangeOAuthCode(
        client.provider,
        client.config(redirectUri),
        code,
      );
      return {
        providerAccountId: user.id,
        email: user.email,
        emailVerified: user.verified,
        name: user.username,
        image: getDiscordAvatarUrl(user),
        tokens,
        raw: user,
      };
    },
  });
}

/** Discord sign-in when both credentials are set, else nothing: see `google.optional`. */
discord.optional = optionalOf(discord);

/**
 * The development sign-in: a picker of the app's demo users, served by the
 * routes through `registerMockOAuthProvider`. Left out (its routes answer
 * nothing) unless `isMockOAuthEnabled()`: `ENABLE_MOCK_OAUTH=true` and
 * `NODE_ENV` other than `production`.
 */
export function mock(options: MockSignInOptions): MockSignInProvider {
  if (typeof options.listUsers !== "function") {
    throw new TypeError("mock(): listUsers is required");
  }
  return Object.freeze({ kind: "mock", id: "mock", options });
}
