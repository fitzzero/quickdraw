// `createAuthRoutes` (RFC 0003 section 12.6): the sign-in surface every app
// used to copy, as one Express middleware the app mounts. It assembles the
// 4.1 helpers (OAuth URL and code exchange, the Google, Discord and mock
// providers, JWTs, the session cookie, origin validation and the Express rate
// limits); the app supplies how a profile becomes its user (`onLogin`) and
// where sessions are stored (`SessionStore`). `socketAuth` authenticates the
// sessions it issues on the server's sockets and HTTP calls.
//
// The routes, under `basePath` (default `/auth`):
//
// | Route | Limiter | Answer |
// |---|---|---|
// | `GET /{provider}/start?returnTo=` | sign-in | 302 to the provider |
// | `GET /{provider}/callback` | sign-in | 302 to the return origin, with the session cookie |
// | `POST /guest` (with `guest()`) | sign-in | `{ userId }`, with the session cookie |
// | `GET /providers` | session | `{ providers: [{ id, name, kind }] }`: the sign-ins served now |
// | `GET /me` | session | `{ userId }`, or 401 |
// | `POST /logout` | session | 204 |
// | `POST /logout-all` | session | 204, or 401 |
// | `/mock/provider/*` (with `mock()`, development only) | none | the mock provider |
//
// A POST route needs `Content-Type: application/json`, like the HTTP
// transport's calls: a cross-site form cannot send it, and a cross-site
// script cannot without a CORS preflight the app's CORS policy refuses.
//
// `GET /providers` (and `routes.providers()`) says which sign-ins are
// served, so a login page offers only those (finding F9.1 of the owner's QA
// of the template: a Google button answered 404 where the instance had no
// Google credentials): a provider `google.optional` built nothing for is not
// in it, and the mock only while it is mounted and `isMockOAuthEnabled()`.

import { INTERNAL_MESSAGE } from "../../../protocol/errors";
import { isJsonRequest } from "../../transports/body";
import { guestRoute } from "./guest";
import { checkRateLimits, loadLimiters, type LimitKind, type Limiters } from "./limits";
import { mockFlow, mockServes } from "./mockFlow";
import { callbackRoute, startRoute, type SignInFlow } from "./oauth";
import { pathOf, refuse, sendJson, type AuthRouteRequest, type AuthRouteResponse } from "./respond";
import { logoutAllRoute, logoutRoute, meRoute } from "./session";
import { routeSettings, type RouteSettings } from "./settings";
import type { AuthProvider, AuthProviderInfo, AuthRoutes, AuthRoutesOptions } from "./types";

/** One route: its handler, the limiter that counts it, and whether it needs a JSON body type. */
interface Route {
  readonly handle: (req: AuthRouteRequest, res: AuthRouteResponse) => unknown;
  readonly limit?: LimitKind;
  readonly json?: boolean;
}

/** The routes by `"{METHOD} {path}"`. */
type RouteTable = Map<string, Route>;

const PROVIDER_ID = /^[a-z0-9][a-z0-9-]*$/;

function checkProvider(provider: AuthProvider, seen: Set<string>): void {
  const { kind, id, authorizeUrl, profile } = (provider ?? {}) as Partial<
    Record<"kind" | "id" | "authorizeUrl" | "profile", unknown>
  >;
  const oauth = typeof authorizeUrl === "function" && typeof profile === "function";
  if (!(kind === "mock" || kind === "guest" || (kind === "oauth" && oauth))) {
    throw new TypeError(
      'createAuthRoutes: providers are google(), discord(), mock(), guest() or { kind: "oauth", id, authorizeUrl, profile }',
    );
  }
  if (typeof id !== "string" || !PROVIDER_ID.test(id)) {
    throw new TypeError(
      `createAuthRoutes: a provider id is lowercase letters, digits and hyphens; got ${String(id)}`,
    );
  }
  if (seen.has(id)) {
    throw new TypeError(`createAuthRoutes: two providers have the id "${id}"`);
  }
  seen.add(id);
}

/** The names a sign-in button shows by default, by provider kind. */
const DEFAULT_NAMES = Object.freeze({ mock: "Mock", guest: "Guest" });

/** A served provider, as `GET /providers` lists it. */
function infoOf(provider: AuthProvider): AuthProviderInfo {
  const name =
    provider.kind === "oauth" ? (provider.name ?? provider.id) : DEFAULT_NAMES[provider.kind];
  return Object.freeze({ id: provider.id, name, kind: provider.kind });
}

/** Adds a provider's routes; the mock provider's only while it is enabled. Returns whether it was mounted. */
function addProvider(table: RouteTable, settings: RouteSettings, provider: AuthProvider): boolean {
  const base = settings.basePath;
  if (provider.kind === "guest") {
    table.set(`POST ${base}/guest`, {
      handle: guestRoute(settings, provider),
      limit: "signIn",
      json: true,
    });
    return true;
  }
  const flow: SignInFlow | null =
    provider.kind === "mock"
      ? mockFlow(provider, settings, (method, path, handle) =>
          table.set(`${method} ${path}`, { handle }),
        )
      : provider;
  if (flow === null) {
    return false;
  }
  table.set(`GET ${base}/${flow.id}/start`, {
    handle: startRoute(settings, flow),
    limit: "signIn",
  });
  table.set(`GET ${base}/${flow.id}/callback`, {
    handle: callbackRoute(settings, flow),
    limit: "signIn",
  });
  return true;
}

/** The sign-ins served now: the providers mounted, the mock only while it is enabled. */
function servedProviders(mounted: readonly AuthProvider[]): readonly AuthProviderInfo[] {
  return mounted.filter((provider) => provider.kind !== "mock" || mockServes()).map(infoOf);
}

function routeTable(
  settings: RouteSettings,
  listed: readonly (AuthProvider | null | undefined | false)[],
): { readonly table: RouteTable; readonly mounted: readonly AuthProvider[] } {
  // An entry left out in place (`google.optional(...)` without credentials) is skipped.
  const providers = Array.isArray(listed)
    ? listed.filter(
        (provider): provider is AuthProvider =>
          provider !== undefined && provider !== null && provider !== false,
      )
    : [];
  if (providers.length === 0) {
    throw new TypeError("createAuthRoutes: providers must list at least one provider");
  }
  const seen = new Set<string>();
  for (const provider of providers) {
    checkProvider(provider, seen);
  }
  const table: RouteTable = new Map();
  const mounted = providers.filter((provider) => addProvider(table, settings, provider));
  if (mounted.length === 0) {
    settings.logger.warn(
      "createAuthRoutes: no provider can sign anyone in (the mock is mounted only while ENABLE_MOCK_OAUTH is set outside production): every sign-in route answers 404",
      { category: "quickdraw.auth" },
    );
  }
  const base = settings.basePath;
  table.set(`GET ${base}/providers`, {
    handle: (_req, res) => {
      sendJson(res, 200, { providers: servedProviders(mounted) });
    },
    limit: "session",
  });
  table.set(`GET ${base}/me`, { handle: meRoute(settings), limit: "session" });
  table.set(`POST ${base}/logout`, { handle: logoutRoute(settings), limit: "session", json: true });
  table.set(`POST ${base}/logout-all`, {
    handle: logoutAllRoute(settings),
    limit: "session",
    json: true,
  });
  return { table, mounted };
}

/** Runs a route once its limiter let it through. */
async function serve(route: Route, req: AuthRouteRequest, res: AuthRouteResponse): Promise<void> {
  if (route.json === true && !isJsonRequest(req)) {
    refuse(res, "VALIDATION", "Send the request with Content-Type: application/json");
    return;
  }
  await route.handle(req, res);
}

function dispatch(
  settings: RouteSettings,
  limiters: Limiters | null,
  route: Route,
  req: AuthRouteRequest,
  res: AuthRouteResponse,
): void {
  const fail = (error: unknown): void => {
    settings.logger.error("An auth route failed", {
      category: "quickdraw.auth",
      path: pathOf(req),
      error: error instanceof Error ? error.message : String(error),
    });
    refuse(res, "INTERNAL", INTERNAL_MESSAGE);
  };
  if (limiters === null) {
    refuse(res, "INTERNAL", "The auth routes' rate limiters are unavailable");
    return;
  }
  const limiter = route.limit === undefined ? undefined : limiters[route.limit];
  if (limiter === undefined) {
    serve(route, req, res).catch(fail);
    return;
  }
  // The limiter answers a refused request itself; it calls `next` to let one through.
  const next = (error?: unknown): void => {
    if (error === undefined) {
      serve(route, req, res).catch(fail);
    } else {
      fail(error);
    }
  };
  try {
    Promise.resolve(limiter(req as never, res as never, next)).catch(fail);
  } catch (error) {
    fail(error);
  }
}

/**
 * The auth routes, as one Express middleware: `app.use(createAuthRoutes(...))`.
 * Mount it after the app's CORS middleware (which must allow credentials for
 * the web app's origins) and before its catch-all routes.
 *
 * @example
 * app.use(
 *   createAuthRoutes({
 *     providers: [google({ clientId, clientSecret }), mock({ listUsers }), guest({ createUser })],
 *     sessions: prismaSessions(prisma),
 *     jwtSecret: env.JWT_SECRET,
 *     onLogin: (profile, provider) => upsertUser(profile, provider),
 *     allowedOrigins: [env.CLIENT_URL],
 *     publicUrl: env.API_URL,
 *   }),
 * );
 */
export function createAuthRoutes(options: AuthRoutesOptions): AuthRoutes {
  const settings = routeSettings(options);
  const rateLimit = checkRateLimits(options.rateLimit);
  const { table, mounted } = routeTable(settings, options.providers);
  const limiters = loadLimiters(rateLimit).catch((error: unknown) => {
    settings.logger.error(
      "createAuthRoutes: the default rate limiters need express-rate-limit; install it, or pass rateLimit",
      { category: "quickdraw.auth", error: error instanceof Error ? error.message : String(error) },
    );
    return null;
  });
  const routes = (
    req: AuthRouteRequest,
    res: AuthRouteResponse,
    next: (error?: unknown) => void,
  ) => {
    const route = table.get(`${req.method ?? ""} ${pathOf(req)}`);
    if (route === undefined) {
      next();
      return;
    }
    settings.watchHost(req);
    void limiters.then((loaded) => {
      dispatch(settings, loaded, route, req, res);
    });
  };
  return Object.assign(routes, { providers: () => servedProviders(mounted) });
}
