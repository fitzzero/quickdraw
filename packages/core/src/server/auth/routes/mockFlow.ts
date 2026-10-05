// The mock provider inside the auth routes: `registerMockOAuthProvider`
// mounts its endpoints (authorize, token, userinfo) on the routes' own table
// under `{basePath}/mock/provider`, and the sign-in drives them like any
// OAuth provider. Nothing is mounted unless `isMockOAuthEnabled()`, and every
// request checks it again, as the mock's own endpoints check `NODE_ENV`.

import {
  createMockOAuthProvider,
  isMockOAuthEnabled,
  registerMockOAuthProvider,
  type MockOAuthRouter,
} from "../mock";
import { createOAuthURL, exchangeOAuthCode, type OAuthConfig } from "../oauth";
import type { SignInFlow } from "./oauth";
import type { MockSignInProvider } from "./providers";
import type { AuthRouteRequest, AuthRouteResponse } from "./respond";
import type { RouteSettings } from "./settings";

/** Where the routes keep a handler the mock provider registers. */
export type MountHandler = (
  method: "GET" | "POST",
  path: string,
  handle: (req: AuthRouteRequest, res: AuthRouteResponse) => unknown,
) => void;

/**
 * The mock provider's sign-in, its endpoints mounted through `mount`, or
 * `null` when `isMockOAuthEnabled()` is false (nothing is mounted then).
 */
export function mockFlow(
  provider: MockSignInProvider,
  settings: RouteSettings,
  mount: MountHandler,
): SignInFlow | null {
  const pathPrefix = `${settings.basePath}/mock/provider`;
  // The mock's handlers take Express's request and response, which the routes are given.
  const router: MockOAuthRouter = {
    get: (path, handler) => {
      mount("GET", path, (req, res) => handler(req as never, res as never));
    },
    post: (path, handler) => {
      mount("POST", path, (req, res) => handler(req as never, res as never));
    },
  };
  const mounted = registerMockOAuthProvider(router, {
    listUsers: provider.options.listUsers,
    pathPrefix,
    allowedRedirectOrigins: [new URL(settings.publicUrl).origin],
    logger: settings.logger,
  });
  if (!mounted) {
    return null;
  }
  const oauth = createMockOAuthProvider(settings.publicUrl, {
    pathPrefix,
    ...(provider.options.internalUrl !== undefined && {
      internalBaseUrl: provider.options.internalUrl,
    }),
  });
  const config = (redirectUri: string): OAuthConfig => ({
    clientId: "mock",
    clientSecret: "mock",
    redirectUri,
  });
  return Object.freeze({
    kind: "oauth",
    id: provider.id,
    enabled: isMockOAuthEnabled,
    authorizeUrl: (state: string, redirectUri: string) =>
      createOAuthURL(oauth, config(redirectUri), state),
    async profile(code: string, redirectUri: string) {
      const { tokens, user } = await exchangeOAuthCode(oauth, config(redirectUri), code);
      return {
        providerAccountId: user.id,
        email: user.email,
        emailVerified: true,
        name: user.name,
        image: user.picture,
        tokens,
        raw: user,
      };
    },
  });
}

/**
 * Whether a mounted mock provider still serves sign-ins: its routes check
 * `isMockOAuthEnabled()` on every request, so `GET {basePath}/providers`
 * lists it only while that holds.
 */
export function mockServes(): boolean {
  return isMockOAuthEnabled();
}
