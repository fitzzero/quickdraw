# RFC 0002: v4 Alignment — Adjacent Fixes, Conveyor Upstream Backlog, Template Backports

- **Status:** Draft
- **Target:** `@fitzzero/quickdraw-core` **4.0.0** (with some items landing in follow-up 4.x minors)
- **Source:** 2026-07-27 three-repo alignment audit (quickdraw-core 3.9.1, quickdraw-chat 3.7.0, Conveyor @ ^3.9.1)
- **Companion:** RFC 0001 (collection subscriptions — the flagship)

Conveyor is the framework's most scaled consumer (28 BaseService services, 174 releases in July 2026) and consumes 3.9.1 cleanly — no fork, no patches, no shadow base class. That makes its hand-built layer a high-signal requirements document: everything below cites the Conveyor (or quickdraw-chat) file that serves as the implementation donor or motivating example. Paths are relative to each repo root.

Audit context worth keeping in mind: Conveyor has **152 `emitToRoom` call sites** and a 317-line hand-typed `SocketEventMap` (~90 events, ~60% of which are row-add/remove compensation for the missing collection primitive). The upstreaming pipeline demonstrably works — Conveyor's `apps/api/src/utils/encryption.ts` is now a pure re-export of core 3.7's encryption, and its Prisma test harness and MCP bootstrap are consumed from core.

---

## 1. Rides with 4.0.0 (breaking or foundational)

### 1.1 DTO generic on BaseService (`TDto`)
See RFC 0001 §1.1. Donor pain: `conveyor/apps/api/src/services/task/service-core.ts:256-273` — `emitUpdate` is typed `Partial<TEntity>` (Prisma row) but every real app emits DTOs, forcing `dto as unknown as Partial<Task>` at every emit site.

### 1.2 Write lifecycle hooks
`beforeCreate/afterCreate/beforeUpdate/afterUpdate/beforeDelete/afterDelete` — see RFC 0001 §1.3. Currently there is no way to attach cross-cutting side effects to writes; collections are the first consumer, but this also unblocks audit logging, denormalized counters, and search indexing without overriding the CRUD trio wholesale.

### 1.3 Room-based `emitUpdate` (multi-node correctness)
Today `emitUpdate` iterates the in-process `subscribers` Map and `socket.emit`s directly (`src/server/BaseService.ts:426-440`), so **entity updates do not cross nodes even with the Redis adapter** — only `emitToRoom` is adapter-aware. Fix via `:full`-room two-tier emission (RFC 0001 §4). Breaking notes: per-socket fallback removed; ACL tier fixed at subscribe time.

### 1.4 Richer socket-auth identity
`createQuickdrawServer`'s `authenticate(socket, auth) => userId` cannot express multiple principal types. Donor: `conveyor/apps/api/src/socket-handlers.ts` (385 lines, hand-rolled) authenticates **four** token types — user JWT, task token, project token, deployment-runner token — with different authorization semantics, which is why Conveyor bypasses `createQuickdrawServer` entirely (0 usages). Proposal: `authenticate` returns a structured identity `{ userId?, principalType?, claims?, serviceAccess? }` stamped onto the socket, and `createQuickdrawServer` becomes adoptable by apps with non-trivial auth.

While here, close two adjacent dead ends found in core:
- `src/server/createServer.ts:74-76` — literal `// TODO: Load service access from user record`; every socket gets `serviceAccess = {}` out of the box. Accept a `loadServiceAccess(userId)` callback (or take it from the identity result).
- The client listens for an `auth:info` event (`src/client/QuickdrawProvider.tsx:285-291`) that **the server never emits**. Emit it post-auth with `{userId, serviceAccess}` so the client context actually works.

### 1.5 Admin type dedupe (bug)
`AdminListResponse` is declared twice with different shapes — `src/shared/types.ts:245-250` (`{rows, page, pageSize, total}`) vs `src/server/types.ts:177-183` (`{items, total, page, pageSize, totalPages}`, the one actually returned). Same for `AdminSetEntryACLPayload {id, acl}` (shared) vs `AdminSetACLPayload {entryId, acl}` (server, actually used). Keep one canonical shape each; breaking, so 4.0 is the moment.

### 1.6 Typed event maps + static room helpers
- Augmentable `interface QuickdrawEventMap {}` in `src/shared/types.ts`; `emitToRoom`/`useRoomEvents` become generically typed with graceful degradation to `string`/`unknown` when the map is empty. Donor: `conveyor/packages/shared/src/types/socket-events.ts` (the pattern, not the contents) + Conveyor's typed wrapper hooks `apps/web/src/hooks/useRoomEvents.ts`.
- Static, shared-module room helpers `serviceRoom(serviceName, entryId)` / `collectionRoom(...)` / `userRoom(userId)`. Donor: `conveyor/packages/shared/src/room-helpers.ts` — exists because core's `getRoomName` is an *instance* method, unusable when emitting into another service's room.

### 1.7 `BaseRpcService` (delegate-less services)
Conveyor declares `BaseService<never, never, never, TMethods>` for method-only services (`apps/api/src/services/cloud-build/index.ts:58`, `vibe-check/VibeCheckService.ts:7`). Provide a first-class `BaseRpcService<TMethods, TChannels>` — methods, channels, ACL, logging; no delegate, no CRUD, no subscriptions.

### 1.8 Bless the service-splitting pattern
Conveyor's `*ServiceCore` (abstract, extends BaseService) + concrete subclass wiring method modules is the only proven way to split a large service without import cycles (`apps/api/src/services/task/service-core.ts:115-122`; `agent-session-service/methods/` has ~40 method modules). Document it as THE pattern in README/CLAUDE.md, and consider a `defineMethods(service, module)` helper. Zero code risk; pure docs+convention.

---

## 2. Client fixes (small, ready to lift verbatim from Conveyor)

| Fix | Donor | Notes |
|---|---|---|
| `useServiceQuery` ignores `refetchInterval` | `conveyor/apps/web/src/hooks/useServiceQuery.ts:91-107` | Framework bug. Donor includes the subtle part: `query.refetch` changes identity every render, so the interval must read it through a ref or it re-arms forever and never fires. |
| Rate-limit backoff | `conveyor/apps/web/src/hooks/useRateLimitBackoff.ts` + `useServiceQuery.ts:82-89` | While the server reports the client rate-limited, pause all reads — rejected events still count against the budget and re-trip the limiter indefinitely. Non-obvious; belongs in the core query hook. |
| Reconnect query resync | `conveyor/apps/web/src/hooks/useReconnectResync.ts` | Core heals *subscriptions* on reconnect but plain `useServiceQuery` reads keep stale data and room events emitted during the outage are gone. Offer `reconnectBehavior: "invalidate-queries"` on `QuickdrawProvider` (opt-out). Collections (RFC 0001) remove the need for the biggest consumers, but query reads still want this. |
| `refetchOnWindowFocus` option-order footgun | `conveyor/apps/web/src/hooks/useSubscription.ts:28-30` | Conveyor documents a real bug where spreading defaults after `...options` made the option dead. Audit core's option merging for the same class of bug. |

---

## 3. Upstream backlog (4.x minors, ranked)

### 3.1 Presence tracker
Donor: `conveyor/apps/api/src/services/presence/index.ts` (152 lines) + the 15s focus-clear grace in `socket-handlers.ts:76-78`. Multi-socket-per-user online tracking, lastSeen, focus state. Zero domain knowledge; presence is a stock realtime feature every quickdraw app wants.

### 3.2 Observability
Donor: `conveyor/apps/api/src/observability/` (runtime, metrics, relay, **privacy/PII-redaction**, winston→OTel logger transport, http middleware — all tested). Core defines only a `Logger` interface today. Proposal: optional `@fitzzero/quickdraw-core/server/otel` subpath (optional peers, same pattern as Redis), plus socket-event metrics in `ServiceRegistry` (donor: `utils/socket-event-stats.ts`) — per-event counters/durations for a socket framework belong in the registry that already logs every method call.

### 3.3 Scheduled jobs
Neither repo has an abstraction: Conveyor's `apps/api/src/periodic-tasks.ts` is raw `setInterval` (every instance runs every sweep — multi-instance unsafe). Greenfield: named-job registry with intervals, jitter, single-instance leases (DB advisory lock or Redis), and logging via the existing `Logger`. Deliberately not bullmq — quickdraw's niche is "zero-thought infra for the common case."

### 3.4 Shared service helpers
Donors in `conveyor/apps/api/src/services/shared/`: `guards.ts` (`requireAuth`, `requireEntity`), `pagination.ts` (`parsePagination`), `schema-builders.ts` (`paginationSchema`, `deleteByIdSchema`, `hexColorSchema`, `ordinalSchema`), `ordinal-utils.ts` (`calculateNextOrdinal`, `reorderEntities` — pairs with RFC 0001's ordering-is-data stance). Every quickdraw app rewrites these.

### 3.5 Scoped-ACL helper
Donor: `conveyor/apps/api/src/services/shared/project-scoped-acl.ts` + `project-access.ts` — entity → parent → membership-table ACL, a concept core lacks (its entry ACL is a JSON column or a full override). Includes a security subtlety worth encoding: a failed entity lookup must **deny**, never fall back to treating the entryId as a scope id. Also add a batched-membership example for `checkBatchSubscriptionAccess` (Conveyor never overrides it; batch subscribe runs N parallel ACL checks today).

### 3.6 Test harness improvements
Donor: `conveyor/apps/api/src/__tests__/utils/socket.ts:1-6` — Conveyor bypassed core's `TestClient` because (a) it hides the raw socket and (b) `connectAsUser` can't carry extra auth claims (taskId). Fix both in `createTestServer`. Add an **ACL role-matrix helper**: Conveyor's testing rules mandate covering six roles (Admin, Moderator, Entry Admin, Entry Read, Outsider, Self) per service — a `describeAclMatrix(service, roles, cases)` helper kills that boilerplate in every consumer.

### 3.7 Docs generation
Donors: `conveyor/scripts/generate-docs.ts` + `generate-mcp-tools-doc.ts` — parse services → methods, access levels, zod schemas, JSDoc → markdown. Core already ships `generateToolMetadata` (MCP-oriented, unused by Conveyor) — reconcile into one method-doc generator that lives next to `defineMethod`. quickdraw-chat has its own `scripts/generate-docs.ts` variant; three copies of this idea exist, none shared.

### 3.8 Tool-contract single-sourcing (evaluate)
Donor: `conveyor/packages/shared/src/tool-contracts/` (1130 lines): `defineToolContract` + field-map spec + compiler serving two MCP surfaces (snake_case in-pod, camelCase external) as frozen wire contracts consumable by docs generation. Generic for any app exposing the same services over multiple MCP surfaces; evaluate for the core MCP module once 3.7's MCP bridge has more consumers.

---

## 4. Known small bugs / drift (fix opportunistically)

- `assertAllMethodsDefined()` referenced in quickdraw-chat's `.claude/rules/api-conventions.md:52` does not exist — real name is `verifyAllMethods()`.
- 3.9.1 shipped without a CHANGELOG entry (last entry 3.9.0, 2026-07-03; 3.9.1 content appears to be the session-cookie 7d fix).
- `ensureAccessForMethod` (`src/server/BaseService.ts:571-574`): methods with **no entryId** at `Read` level allow ANY authenticated user. Intentional for list methods, but undocumented — document it loudly or make it opt-in, since it's a permissiveness surprise for auditors.
- `create()` emits `emitUpdate(newId, entity)` to a room nobody can be subscribed to yet — harmless but misleading; superseded by collection `added` deltas (RFC 0001).

## 5. Conveyor-side cleanups (tracked as Conveyor cards, not core work)

Filed 2026-07-27 alongside this RFC: adopt `defineChannel`/`emitToRoomVolatile` for PTY streaming (currently an `emitToRoom` override with hand-rolled log suppression at `agent-session-service/service-core.ts:444`); multi-instance-safe periodic tasks; adopt unused core features (`emitToUserRoom`, OAuth providers, `zodToAdminFields`, env helpers, tiered rate limiter, `installAdminMethods` beyond 8/28 services); batched `checkBatchSubscriptionAccess`; and the umbrella 4.0 collection-subscription migration (order in RFC 0001 §7 Phase 4).

## 6. quickdraw-chat backport checklist (post-4.0)

The template pins core **3.7.0** (two minors behind Conveyor even pre-4.0) and its own lists have the gap the framework is fixing (`apps/web/src/app/chats/page.tsx:192-200` — `staleTime: 0` + manual `onRefresh`; `ChatWindow.tsx:23-64` — hand-rolled `useRoomEvents` + `useState` merge with a fragile pairing comment).

1. Bump to core 4.0; migrate per RFC 0001 Phase 3 (chat list = `myChats` user-scoped collection with fan-out scopes; messages = `byChat` unbounded collection). This becomes the README headline example.
2. Adopt typed `QuickdrawEventMap` for the remaining custom events (`chat:memberUpdate`, typing).
3. Mount reconnect query resync in the provider (or the core `reconnectBehavior` option, §2).
4. Add a `services/shared/` helper directory demonstrating guards/pagination/schema-builders (§3.4) — or consume them from core once upstreamed.
5. Adopt the ACL role-matrix test helper (§3.6) in the four service int suites.
6. Wire the MCP server scaffold (`apps/api/src/mcp-server.ts` exists but has no script, no `.mcp.json`, no docs) or delete it.
7. Replace the template-local `scripts/generate-docs.ts` with the core generator (§3.7).
8. Demonstrate `invalidateOn` (documented in `.claude/rules/client-patterns.md:19-22`, used zero times in the app) on at least one genuinely query-shaped read — or delete the doc claim once collections cover it.
