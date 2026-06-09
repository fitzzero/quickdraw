# Changelog

All notable changes to this project will be documented in this file.

## [3.7.0] - 2026-06-09

### Added

- **Mock OAuth provider** (`/server`): `createMockOAuthProvider`, `registerMockOAuthProvider`, `isMockOAuthEnabled` — a real authorization-code flow served by the app's own API for local development. Renders a seeded-user picker, mints single-use codes and short-lived tokens in memory, and returns GoogleUser-compatible userinfo with `id` = email (stable `providerAccountId` across re-seeds). Hard-blocked in production: routes never mount, and handlers re-check `NODE_ENV` per request. Enable with `ENABLE_MOCK_OAUTH=true`.
- **Origin validation** (`/server`): `validateRedirectOrigin` + `OAUTH_RETURN_ORIGIN_COOKIE` for OAuth redirect/CORS allowlisting — CLIENT_URL, `EXTRA_ALLOWED_ORIGINS`, GitHub Codespace origins, localhost in dev, and app-specific `allowedPatterns`.
- **Session cookies** (`/server`): `setSessionCookie` / `clearSessionCookie` / `SESSION_COOKIE` — httpOnly, secure + SameSite=None in production (cross-site API origins), Lax in dev, optional `COOKIE_DOMAIN`.
- **REST auth middleware** (`/server`): `createRequireAuth({ getSession })` — session-cookie or Bearer JWT auth with injected session revocation lookup; plus `extractBearerOrCookieToken`.
- **Encryption utilities** (`/server`): AES-256-GCM `encrypt` / `decrypt` / `isEncrypted` / `decryptIfEncrypted` / `tryDecrypt` keyed by `ENCRYPTION_KEY` (64-char hex) for at-rest secrets like stored OAuth tokens.
- **New subpath `/server/express`**: Express rate-limit factories (`createAuthLimiter`, `createWebhookLimiter`, `createPublicApiLimiter`, `createJsonRateLimiter`, …) built on the optional `express-rate-limit` peer. JSON 429 body + Retry-After.
- **New subpath `/server/testing/prisma`**: dual-mode Prisma test databases — `createPrismaTestGlobalSetup` picks real PostgreSQL (per-worker databases cloned from a migrated template DB) when `TEST_DATABASE_URL` is set, else PGlite with a fingerprint-cached gzip data-dir template. Also exports `resetDatabase` (dynamic TRUNCATE with deadlock retry), `workerDatabaseUrl`, `buildPgliteTemplate`, `setupPostgresWorkerDatabases`, and friends. Optional peers: `@electric-sql/pglite`, `pg`.
- **ESLint plugin rules**: `no-raw-service-room-string` (configurable `additionalPatterns`), `no-raw-button-strings`, `no-raw-tooltip-strings`, `no-raw-typography-strings`.

## [3.6.0] - 2026-04

### Added

- `refetchOnWindowFocus` option for `useSubscription`

## [3.4.0] / [3.3.x] / [3.2.0] - 2026-03

### Added

- 3.4.0: `useRoomEvents` hook and `invalidateOn` option for `useServiceQuery` (changelogged below under its original 1.3.0 heading)
- 3.3.x: `defineMethod` visibility opened up in `BaseService` for external access
- 3.2.0: subscription batching (`batchSubscribe`)

## [3.5.0] - 2026-03-27

### Fixed

- `batchSubscribe` now joins socket rooms for all ACL-allowed IDs before entity resolution, matching `subscribe()`'s behavior. Previously, clients batch-subscribing to an ID that passed access checks but had no entity yet would not join the room and would miss future updates. This is a non-breaking behavioral fix — return values are unchanged (missing entities still return `null`), but sockets now correctly receive updates for entities created after subscription time.

## [1.3.0] - 2026-03-20

### Added

- `useRoomEvents` hook for lifecycle-managed custom socket event listeners
  - Handles `socket.on`/`socket.off` cleanup automatically
  - Re-attaches listeners on reconnect
  - Handler functions stored in refs to avoid effect churn
  - Pair with `useSubscription` (room membership) for room-scoped events
- `invalidateOn` option for `useServiceQuery`
  - Listens for socket events and auto-refetches the query
  - Debounces rapid-fire events within 100ms
  - Ideal for keeping list queries in sync with real-time changes
- `UseRoomEventsOptions` type
- ESLint rule `no-raw-socket-on` — flags `socket.on()` in components, suggests `useRoomEvents`
- ESLint rule `no-raw-socket-emit` — flags `socket.emit()` in components, suggests `useService`/`useServiceQuery`
- Quickdraw ESLint plugin now included in `client` config with socket rules enabled as warnings

## [1.2.0] - 2026-01-17

### Added

- `useServiceQuery` hook for read operations with TanStack Query caching
  - Automatic request deduplication across components
  - Configurable `staleTime` and `gcTime` for cache management
  - `skipCache` option to force fresh fetch
  - `enabled` option for conditional fetching
  - Background refetching when data becomes stale
- `UseServiceQueryOptions` and `UseServiceQueryResult` types

### Fixed

- `useService` and `useServiceMethod` now return memoized objects to prevent infinite render loops when used in `useCallback`/`useEffect` dependencies

## [1.1.0] - Previous

### Added

- Subscription registry for deduplication across components
- HMR/Fast Refresh safe subscription handling

## [0.1.0] - Initial

### Added

- Initial package structure with server/client/shared subpath exports
- `BaseService` class with typed CRUD, subscriptions, and ACL support
- `ServiceRegistry` for auto-discovering and wiring service methods
- `createQuickdrawServer()` helper for one-liner server setup
- JWT utilities for token creation and verification
- OAuth providers for Discord and Google
- `QuickdrawProvider` with TanStack Query integration
- `useService` hook for typed service method calls
- `useSubscription` hook for real-time entity subscriptions
- Socket input components: Checkbox, TextField, Select, Slider, Switch
- Server and client testing utilities
