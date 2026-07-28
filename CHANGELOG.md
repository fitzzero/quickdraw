# Changelog

All notable changes to this project will be documented in this file.

## [4.0.0] - 2026-07-28

The collection-subscriptions major (RFCs 0001 + 0002, `docs/rfcs/`). See
`UPGRADE-PROMPT.md` for the 3.x → 4.0 migration guide.

### Added

- **Collection subscriptions** — the missing primitive for live lists. A
  collection is "rows of this service, grouped by a scope id derived from the
  row"; membership is a pure function of the row:
  - `defineCollection(name, { resolveScopeId, checkScopeAccess, snapshot, toItem?, defaultLimit?, revOf? })`
    declared in the constructor next to `defineMethod`/`defineChannel`, with a
    new `TCollections` generic on `BaseService`. `resolveScopeId` may return
    `null` (predicate filtering) or `string[]` (fan-out scopes).
  - The CRUD trio emits `added`/`updated`/`removed` deltas to scope rooms
    automatically, including scope moves (removed-from-old + added-to-new) and
    predicate entry/exit — no more hand-typed `*:created/deleted` events.
  - Manual choke points for hand-rolled write paths: `emitCollectionUpsert`,
    `emitCollectionRemove`, `emitCollectionMove`, `emitCollectionReset`, plus
    adapter-safe `kickFromCollection(collection, scopeId, userId?)`.
  - Wire protocol: `{service}:collection:subscribe` (cursor-less calls join the
    scope room and may carry a full membership `ids` list, capped at 5,000 with
    `idsTruncated`; cursor-bearing calls are pure paging) and
    `{service}:collection:unsubscribe`. Deltas carry per-item last-writer-wins
    `rev`s; reconnect correctness comes from re-snapshot + `ids` pruning, not
    an event log.
  - Client: `useCollection(serviceName, collection, scopeId, options)` →
    `{ items, byId, totalCount, isLoading, hasMore, loadMore, refresh, … }`,
    riding the existing ref-counted subscription registry (dedup across
    components, re-snapshot on reconnect). Merge logic lives in the pure,
    exhaustively tested `collectionCache` module: id-keyed upserts, rev LWW,
    removal tombstones, delta buffering during in-flight snapshots, cursored
    page merge that never prunes.
  - ACL model: collection items are _scope-visible_ — anyone passing
    `checkScopeAccess` sees every item in full. Strip sensitive fields in
    `toItem`/`snapshot`; per-subscriber tiering inside a collection is
    deliberately unsupported.
- **Write lifecycle hooks** on `BaseService`: `beforeCreate`/`afterCreate`,
  `beforeUpdate`/`afterUpdate`, `beforeDelete`/`afterDelete`. `before*` may
  veto by throwing; `delete()` finally sees the deleted row. The pre-write
  fetch happens only when a service has collections or overrides an
  update/delete hook.
- **`TDto` generic + `toDto()`** — services whose wire shape differs from the
  Prisma row declare it once; `emitUpdate(id, data: Partial<TDto>)` kills the
  `dto as unknown as Partial<TEntity>` cast. `toDto` feeds auto-emission,
  subscribe payloads, and default collection items.
- **Richer socket auth** in `createQuickdrawServer`: `authenticate` may return
  a structured `QuickdrawIdentity` (`{ userId?, principalType?, claims?,
serviceAccess? }`) for multi-principal apps; new `loadServiceAccess(userId)`
  callback replaces the long-standing empty-serviceAccess TODO; the server now
  actually emits `auth:info` (`{ userId, serviceAccess, principalType }`); and
  authenticated sockets join `user:{userId}` so `emitToUserRoom` works out of
  the box.
- **`BaseRpcService`** — first-class delegate-less services (methods,
  channels, ACL, room emits; no CRUD, no subscriptions). Replaces the
  `BaseService<never, never, never, TMethods>` contortion.
- **Typed room events**: augmentable `QuickdrawEventMap` types
  `emitToRoom`/`emitToRoomVolatile`/`emitToUserRoom` and `useRoomEvents`, with
  graceful degradation to `string`/`unknown` while the map is empty.
- **Static room helpers** from the package root: `serviceRoom`,
  `serviceFullRoom`, `collectionRoom`, `collectionEventName`, `userRoom` —
  usable from shared modules and when emitting into another service's rooms.
- **Client query fixes**: `useServiceQuery` passes through `refetchInterval` /
  `refetchIntervalInBackground`; rate-limit backoff (server `RATE_LIMITED`
  reports and 429 acks pause all reads until the window elapses — rejected
  events would otherwise re-trip the limiter forever); hook errors carry the
  server code via `ServiceCallError`; `reconnectBehavior:
"invalidate-queries"` (opt-out) on `QuickdrawProvider` heals plain query
  reads after reconnects.
- **ESLint plugin**: new `quickdraw/no-manual-collection-events` (warn in the
  base config's services override) flags hand-emitted
  `*:created/deleted/updated/reordered` events; the existing
  `no-direct-prisma-mutations` rule is now registered.

### Changed (breaking)

- **`emitUpdate` is room-based and two-tier.** Elevated subscribers join
  `{service}:{id}:full` at subscribe time; full payloads go to the full room,
  protected-fields-stripped payloads to everyone else. This fixes entity
  updates never crossing nodes under the Redis adapter. Consequences:
  - The per-socket emission fallback is removed — `emitUpdate`, `emitToRoom`,
    and `emitToRoomVolatile` require the service to be registered (`setIo`).
  - The subscriber's tier is fixed at subscribe time (a `serviceAccess` change
    takes effect on re-subscribe), and live emits have exactly two tiers; a
    custom `filterEntityForSubscriber` still shapes initial subscribe payloads.
  - `emitUpdate(entryId, data)` takes `Partial<TDto>` (was `Partial<TEntity>`).
- **`subscribe`/`batchSubscribe` return DTO-shaped data**
  (`Partial<TDto> | null`), mapped through `toDto` and filtered per tier.
  `filterEntityForSubscriber`/`getProtectedFields`/`stripProtectedFields`
  retype from `TEntity` to `TDto`.
- **Admin types deduped to one canonical shape each** (the shapes the server
  actually sends): `AdminListPayload {page?, pageSize?, where?, orderBy?}`,
  `AdminListResponse {items, total, page, pageSize, totalPages}`,
  `AdminSetACLPayload {entryId, acl}` (replacing `AdminSetEntryACLPayload`),
  `AdminSubscribersResponse {entryId, subscribers, count}`, and
  `{entryId}`-keyed payloads + truthful responses for
  getSubscribers/reemit/unsubscribeAll. The divergent aspirational variants in
  the root export are gone.
- `adminUnsubscribeAll` evicts subscribers via rooms (adapter-safe,
  cluster-wide) instead of only clearing the local map.
- `create()`/`update()` emit `toDto(entity)` instead of the raw entity.

### Fixed

- Entity updates now propagate across nodes with the Redis adapter (the
  `subscribers`-map iteration never did; it remains only for
  `adminGetSubscribers` introspection).
- `useServiceQuery` no longer silently ignores `refetchInterval`.
- The client `auth:info` listener finally has a server counterpart.
- `SocketTextField` no longer swallows a consumer-provided `type` or `onBlur`
  (the defaults-after-options footgun class from the option-merge audit).

## [3.9.1] - 2026-07-03

### Fixed

- Session cookies default `maxAge` to 7 days (was 30), matching the default
  JWT expiry — a cookie that outlives its JWT just keeps sending a token the
  server rejects. Pass `maxAgeMs` to `setSessionCookie` if your JWT lifetime
  differs. (Backfilled entry; 3.9.1 shipped without one.)

## [3.9.0] - 2026-07-03

### Added

- **Shared oxlint base config** — `oxlint.base.jsonc` ships with the package; consumers extend it from their root `.oxlintrc.json` (`"extends": ["./node_modules/@fitzzero/quickdraw-core/oxlint.base.jsonc"]`) so framework lint best practices update with the package. Includes the strict rule set (type-safety `no-unsafe-*` family, complexity budgets, pedantic category) and pre-wires the `quickdraw` jsPlugin with path-scoped overrides for `services/**`, client code, shared/db packages, and tests. See README "Linting" for merge-semantics caveats (`plugins`/`ignorePatterns` are not inherited). The `./eslint-config` ESLint flat-config export is now considered legacy.

### Changed

- Repo now dogfoods the base config via `.oxlintrc.json` (the previous `oxlintrc.json` was never auto-discovered by oxlint — the repo was linting with defaults). Pre-existing violations are downgraded to `warn` as tracked debt.
- Removed legacy `.cursor/` and `.serena/` tooling configs and the stale `pnpm-lock.yaml` (bun is the package manager); added `CLAUDE.md`.

## [3.8.0] - 2026-07-02

### Added

- **Channels** — first-class fire-and-forget events for high-frequency traffic (game input, cursor positions, typing indicators), the counterpart to request/response methods:
  - `BaseService.defineChannel(name, access, handler, { schema, ratePerSecond, burst, requireRoom })` with a new 5th `TChannels` type param on `BaseService`. No ack, no response; zod validation required; handler errors are logged, never sent to the client.
  - Per-socket, per-channel token bucket (`ratePerSecond`, default 30; `burst`, default 2×) replaces the global rate limiter for channel events. Excess messages are silently dropped; sustained extreme flooding disconnects the socket.
  - Access checks are fully synchronous and in-memory: auth always required; `Moderate`/`Admin` check `socket.serviceAccess`; entry-level access via `requireRoom` (socket must already be in the room, which was ACL-gated at subscribe time). Zero DB reads on the hot path.
  - Channels route as `channel:<serviceName>:<channelName>` — shared helper `channelEventName()` + `CHANNEL_EVENT_PREFIX` exported from the root entry, making the wire contract easy to speak from non-JS clients (e.g. game engines).
  - `BaseService.emitToRoomVolatile(room, event, data)` — volatile room broadcast for tick-rate server→client state (backpressured clients drop frames instead of queueing).
  - Client: `useChannelSend(serviceName, channelName)` → `{ send, isReady }` (volatile emit). Receiving needs nothing new — pair with `useRoomEvents`.
  - Shared types: `ServiceChannelDefinition`, `ServiceChannelContext`, `ServiceChannelMap`.
- **`excludePrefixes` option** for `createRateLimiter` — skip rate limiting for event-name prefixes; pass `[CHANNEL_EVENT_PREFIX]` so channel traffic bypasses the global limiter.
- **`socketPath` prop** for `QuickdrawProvider` — custom Socket.io path for path-rewriting proxies (e.g. Discord Activities require `/.proxy/api/socket.io`).

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
