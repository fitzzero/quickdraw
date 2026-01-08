/**
 * Generic OAuth provider interface.
 */
export interface OAuthProvider<TUser = unknown> {
  name: string;
  authorizationUrl: string;
  tokenUrl: string;
  userInfoUrl: string;
  scopes: string[];

  /**
   * Parse user info response into a standardized format.
   */
  parseUserInfo: (data: unknown) => TUser;
}

/**
 * OAuth configuration for a provider.
 */
export interface OAuthConfig {
  clientId: string;
  clientSecret: string;
  redirectUri: string;
}

/**
 * OAuth token response.
 */
export interface OAuthTokenResponse {
  access_token: string;
  token_type: string;
  expires_in?: number;
  refresh_token?: string;
  scope?: string;
}

/**
 * Create an OAuth authorization URL.
 *
 * @param provider - The OAuth provider
 * @param config - OAuth configuration
 * @param state - Optional state parameter for CSRF protection
 */
export function createOAuthURL(
  provider: OAuthProvider,
  config: OAuthConfig,
  state?: string
): string {
  const params = new URLSearchParams({
    client_id: config.clientId,
    redirect_uri: config.redirectUri,
    response_type: "code",
    scope: provider.scopes.join(" "),
  });

  if (state) {
    params.set("state", state);
  }

  return `${provider.authorizationUrl}?${params.toString()}`;
}

/**
 * Exchange an OAuth authorization code for tokens and user info.
 *
 * @param provider - The OAuth provider
 * @param config - OAuth configuration
 * @param code - The authorization code from the callback
 */
export async function exchangeOAuthCode<TUser>(
  provider: OAuthProvider<TUser>,
  config: OAuthConfig,
  code: string
): Promise<{ tokens: OAuthTokenResponse; user: TUser }> {
  // Exchange code for tokens
  const tokenResponse = await fetch(provider.tokenUrl, {
    method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
      Accept: "application/json",
    },
    body: new URLSearchParams({
      client_id: config.clientId,
      client_secret: config.clientSecret,
      code,
      grant_type: "authorization_code",
      redirect_uri: config.redirectUri,
    }),
  });

  if (!tokenResponse.ok) {
    const error = await tokenResponse.text();
    throw new Error(`Token exchange failed: ${error}`);
  }

  const tokens = (await tokenResponse.json()) as OAuthTokenResponse;

  // Fetch user info
  const userResponse = await fetch(provider.userInfoUrl, {
    headers: {
      Authorization: `Bearer ${tokens.access_token}`,
      Accept: "application/json",
    },
  });

  if (!userResponse.ok) {
    const error = await userResponse.text();
    throw new Error(`User info fetch failed: ${error}`);
  }

  const userData = await userResponse.json();
  const user = provider.parseUserInfo(userData);

  return { tokens, user };
}
