# RFC 0003 audit: why quickdraw 5.0 looks the way it does

Status: accepted by the owner 2026-10-02 with the decisions in section 10. Companion to `0003-v5.md`.
Baseline: `@fitzzero/quickdraw-core` 4.1.0, `main` at `f767f68`.

## 1. Verdict

Rebuild the core, keep the concepts and the transport.

- **Rebuild:** `BaseService`, `ServiceRegistry`, the wire protocol and the client hooks. They are about 7k lines of non-test source; the redesign below changes their foundations, so patching them costs more than replacing them.
- **Keep:** the vocabulary every app and agent already knows (service, method, access level, entity subscription, collection, channel), Socket.IO, TanStack Query, Prisma, and the proven pieces (`collectionCache` merge logic, channels, auth helpers, rate limiters).
- **Do not adopt:** tRPC, a sync engine, or a database change-capture pipeline as the core. Reasons in section 6.

The cost of v5 is not writing the framework. It is migrating about 1,240 methods in 8 apps. Every API change below is chosen so a codemod plus a lint rule can carry most of that.

## 2. What the audit found

Provenance: quickdraw findings were read directly from source. Consumer, URC and landscape findings come from delegated audits and are cited as reported.

### 2.1 The framework's automatic emitting covers about 7% of real writes

This is the main finding. `create/update/delete` on `BaseService` are the only writes that emit to subscribers and collections automatically.

| App | Writes through the framework | Raw Prisma writes in services |
|---|---|---|
| Conveyor | about 51 | about 605, plus 129 inside transactions (37 `$transaction` blocks) |
| farseer | 5 | 55 |
| quickdraw-chat (the template) | 7 | 12 |

Every raw write needs a hand-written emit. Consequences in Conveyor:

- 77 manual `emitUpdate` / `emitCollection*` calls, and an AST test (`apps/api/src/services/task/__tests__/card-emit-enforcement.test.ts`) that exists only to catch forgotten ones.
- "Missed emit from a raw write" is the largest recurring bug class (about 16 fix commits, for example `a1b797e5b`, `7f496d794`).
- `CardRemovalShadow` exists because a late upsert can resurrect a deleted card: the emit API accepts no caller revision.

### 2.2 Access control is mostly hand-written, and one default is open

- `ensureAccessForMethod` lets any authenticated user call a `Read` method that has no entry id (`src/server/BaseService.ts:597-600`). Conveyor has 116 such methods, each relying on an inline check; farseer patched the hole in app code (`apps/api/src/utils/acl.ts:58-77`).
- One access level is applied to both the service-wide grant and the per-row grant, so view-only sharing cannot be expressed (the open card "Separate service-level and entry-level thresholds").
- Conveyor overrides `checkEntryACL` 24 times and `checkBatchSubscriptionAccess` 16 times, and has 67 inline `checkProjectAccess` calls. Six of seven other apps re-implement "inherit access from the parent row".
- `subscribe()` joins the room before it fetches the row (`BaseService.ts:204-213`), so a failed subscribe can leave a socket in the room.
- A denied call returns code 500, not 403: every thrown error maps to 500 (`src/server/ServiceRegistry.ts:398-402`). `update()` and `delete()` swallow all errors and return `null` / `false` (`BaseService.ts:793-795, 816-818`).

### 2.3 Types are declared up to six times, and every app wraps the client

- Each method's payload is written twice (a TypeScript map in `packages/shared`, a Zod schema in `apps/api`), 1,240 times in total. The schema is optional (`BaseService.ts:849`).
- A service's name is restated in six places per app.
- Client hooks take `serviceName: string, methodName: string`. All 8 apps ship their own typed wrapper files (6 files in Conveyor).
- `BaseService` has seven generic parameters.

### 2.4 Performance is unmanaged

Read directly in 4.1.0:

- One listener per method per socket (`ServiceRegistry.ts:118-136`). Conveyor registers roughly 800 closures on every connection, and Cloud Run's 60-minute socket cap reconnects about 190 sockets at once.
- No cancellation, no server timeout, no concurrency cap, no dedupe of identical reads, no payload-size visibility.
- Two `info` logs per call by default (`ServiceRegistry.ts:331-373`).
- Collection revisions are `Date.now()` (`src/server/collections.ts:162, 335`); entity updates carry no revision at all (`src/client/useSubscription.ts:109-126`).
- Every delta carries the full item; every reconnect re-snapshots everything (`src/client/QuickdrawProvider.tsx:326-330`).
- Conveyor replaced `invalidateOn`, the reconnect policy and the rate-limit backoff with its own code, and `useBoardData.ts` is 1,097 lines of safety nets around `useCollection`.

### 2.5 The repo itself

- No CI, no release automation, no LICENSE file, manual `npm publish`.
- Tests are never typechecked (`tsconfig.json` excludes them). Every client hook test mocks the provider, so no test runs a hook against a real server. The 12 lint rules have no tests.
- Packaging defects: `express` is imported at runtime but only a devDependency; `"use client"` is stripped from the built client bundle; `./server/testing` bundles a second copy of the registry; `./client/testing` uses a private context the hooks never read; ESLint packages are peers of the core package.
- Dependencies trail every consumer: Prisma 5 (all apps are on 7), vitest 1 (apps on 4 or 5), React 18 types (apps on 19).

### 2.6 What the template copies into every app

Reported by the consumer audit: the 323-line server bootstrap, 10 auth files, the service helpers (`guards`, `pagination`, `schema-builders`), the test setup, the admin hooks and the hook wrappers are copied near-verbatim into 4 to 6 apps. The template's own comment says these are "candidates for upstreaming".

## 3. Design

Seven pillars. The API sketches are illustrative, not final.

### 3.1 One schema source (the contract)

A service's contract lives in the shared package: the entity shape, each method's input and output, collections and channels. Everything else is inferred from it: client types, room names, MCP tool metadata, admin metadata, docs.

```ts
// packages/shared/src/contracts/chat.ts
export const chat = defineContract("chat", {
  entity: z.object({ id: z.string(), title: z.string(), ownerId: z.string() }),
  methods: {
    updateTitle: {
      input: z.object({ id: z.string(), title: z.string().min(1) }),
      output: "entity",
    },
  },
  collections: { mine: { scope: "userId", item: chatListItem } },
});
```

Schemas are accepted as Standard Schema, so today's Zod 3.25 schemas keep validating. Zod 4.2 is needed only where JSON Schema is generated (MCP, admin).

### 3.2 Tracked writes: emits are derived, never hand-written

The framework hands each method a database client that records every write: which model, which row, which fields. Raw writes, writes inside a transaction, bulk writes and writes to another service's model are all recorded. After the transaction commits, the framework:

1. merges the request's writes (ten updates to one row become one emit);
2. takes a revision, then reads each touched row once through its declared projection;
3. emits the entity update, the collection deltas (added, updated, removed, moved between scopes) and invalidation hints for queries declared as depending on that data.

Collections declare their scope as a column (`scope: "projectId"`), not a function. The framework then knows a write that does not touch that column cannot move the row, and skips the pre-read.

Gaps and their guards: raw SQL and nested writes are not seen by a Prisma extension. A lint rule flags both, and `ctx.touch(model, ids)` reports them explicitly. A trigger-written change log (drained by polling, not `NOTIFY`) is a later option for writes made outside the app process.

### 3.3 Declarative access control, closed by default

- A service declares one policy from four building blocks that cover what all 8 apps write by hand: `owner(field)`, `jsonAcl(field)`, `members(table)`, `inherit(parentService, foreignKey)`. A custom resolver is the escape hatch.
- Every method declares who may call it. There is no implicit "any signed-in user"; that becomes an explicit `"authenticated"`.
- A method can set separate thresholds for a service-wide grant and a per-row grant.
- The same policy gates method calls, entity subscriptions, collection scopes and list filtering, and it is batched and memoized per request by default.
- A membership change revokes live subscriptions automatically.
- Errors are typed: 401, 403, 404, 409, 422, 429, 504 and 500, with internal messages no longer leaked to the client.

### 3.4 Protocol v5

One request envelope over one event: request id, method, input, and the revision the client already holds. That gives, without bolt-ons:

- cancellation (`ctx.signal`), server timeouts and a per-socket concurrency cap;
- "not modified" replies and revision catch-up on reconnect;
- one listener per socket instead of one per method;
- a JSON-only parser (no recursive binary scan), with each response serialized once and its size measured;
- one completion metric per call.

The protocol is not wire-compatible with 4.x. A version handshake tells an old browser tab to reload. A one-listener legacy shim keeps 4.x request/response callers working during a rollout; Conveyor needs it for its agent, MCP, k3 and deploy-runner clients (about 207 call sites through `packages/shared/src/socket-core/call-with-ack.ts`).

The same dispatcher is exposed over HTTP (server-side prefetch, load tests, webhooks), MCP and in-process calls (tests, service-to-service).

### 3.5 Typed client

```ts
const rename = qd.chat.updateTitle.useMutation();          // optimistic by default for entity updates
const { items } = qd.chat.mine.useCollection(userId);
const chatRow = qd.chat.useEntity(chatId);
```

- No wrapper files and no string names.
- An invalidation coordinator: one read in flight per key, one queued follow-up, shared across hooks, jittered after a reconnect or a rate limit.
- Invalidation is declared in the contract, replacing `invalidateOn` strings and manual `refetch()` (63 in farseer).
- Collections resume from a revision, refresh on tab visibility, and run an idle convergence check, so apps stop writing those nets.
- Socket manager options are exposed; React Native stays supported.

### 3.6 Performance as a tested property

- **Lean projections:** the entity and collection-item schemas determine the `select`, so a list read cannot ship a detail-sized row.
- **Bounded reads by contract:** every list and collection has a hard limit and a keyset cursor. No silent truncation at 100 rows.
- **Budgets:** a test helper records SQL statements and response bytes per method as a snapshot; growth fails the test unless explicitly allowed.
- **Development warnings:** a query inside a loop, an oversized response, an unbounded read.
- **Built-in:** per-method metrics hook, event-loop stall watchdog, optional OpenTelemetry.
- **Benchmark harness:** a scripted scenario (many viewers of one board plus a fleet of writers) run baseline, change, baseline on equal hardware. 4.1 numbers are recorded before the rebuild starts.

### 3.7 Standard kits, opt-in

One line each in a contract; all go through the same access and emit pipeline.

| Kit | Evidence | Proposed for 5.0 |
|---|---|---|
| Read and write: get, list (cursor, filtered by access, bounded), create, update, delete, reorder, bulk | about 270 of 579 methods in the 7 smaller apps | Yes |
| Sharing and membership: share, unshare, invite, remove, leave, members | 63 methods across 6 apps | Yes |
| Admin: typed, all-Admin by default | 26 services in Conveyor; untyped hooks in every app | Yes |
| Server factory that accepts an existing Express app | 7 apps copy the bootstrap | Yes (part of the core) |
| Search, and whole-scope loading with an index and views | Conveyor's `useBoardData.ts` mirrors server filters on the client (1,097 lines) | Yes (owner request) |
| Presence and streams (seed, then append) | 6 apps reach into `io` | Yes (owner decision) |
| Auth routes (Google, Discord, mock, guest) | 10 files copied in 5 to 6 apps | Yes (owner decision) |
| Scheduled jobs | none exists; Conveyor uses raw `setInterval` | 5.1 |

## 4. Enforcement

Order of preference: make it impossible in types, then lint, then a development warning, then documentation.

New lint rules:

| Rule | Prevents |
|---|---|
| `no-untracked-write` | Writing through a database client the framework cannot see. Replaces `no-direct-prisma-mutations` and `no-cross-service-mutations` (disabled inline 70 times in Conveyor); adopts foundation's model-owner map |
| `no-manual-emit` | Hand-emitting entity or collection events |
| `no-nested-write`, `no-raw-sql-write` | The two gaps in write tracking |
| `no-inline-auth-guard` | `if (!ctx.userId) throw` instead of a declared access (92 in farseer) |
| `no-unbounded-read`, `no-db-call-in-loop`, `no-emit-in-loop`, `no-load-then-filter` | The common performance mistakes |
| `no-await-void-mutate` | Upstreamed from Conveyor |
| `no-prisma-in-routes`, `no-cross-service-internal-imports` | Upstreamed from 5 apps and from foundation |
| `no-untyped-client`, `no-manual-refetch` | Bypassing the typed client and the coordinator |
| `no-v4-api` | Every removed 4.x API, with the replacement in the message |

Also:

- Baselines, so an app can adopt a rule without fixing every existing violation first.
- Tests for every rule.
- The design-system rules (`no-raw-typography-strings` and two others) move out of the framework plugin into a template preset.
- Agent rules and skills ship inside the package and are linked into `.claude/` by a `quickdraw link` command, the way `@rallycry/conveyor-skills` does it. Today that guidance is hand-forked and differs in all four apps checked.

## 5. Repo modernization

- Bun workspaces with turbo: the framework package, the lint package, and the skills.
- CI: lint, format, typecheck including tests, build, tests split into node and jsdom projects, hook tests against a real server, type tests, `publint` and `arethetypeswrong`, audit.
- Owner-triggered, tag-driven publish with OIDC and provenance; prereleases go out under the npm `next` tag.
- Fix every packaging defect in 2.5.
- Baseline: Node 24, pinned bun, Prisma 7 through a structural adapter (the framework can no longer import Prisma types), React 19, Socket.IO 4.8.4, vitest 4 or later.
- Husky hooks, Renovate, LICENSE, CONTRIBUTING.
- The design in this document committed as `docs/rfcs/0003-v5.md`.

## 6. What was considered and rejected

| Option | Verdict | Reason |
|---|---|---|
| Replace Socket.IO with tRPC | Reject | No rooms, no multi-instance fan-out, subscriptions are SSE-first. Its type inference and `AbortSignal` ideas are adopted |
| Raw `ws`, uWebSockets or Bun sockets | Reject | Gains matter at 10,000 or more sockets; acks, reconnect and adapters would be rebuilt |
| oRPC | Watch | Closest in shape, but v2 is in beta with a wire-breaking serializer |
| Zero, Convex, Instant and similar | Reject | Each replaces the framework and owns the data model |
| TanStack DB as the client store | Watch | Still pre-1.0; a candidate optional adapter after 5.0 |
| Database change capture as the emit source | Reject for the core | `NOTIFY` serializes commits (URC measured 2,300 against 8,900 commits per second); replication slots add operations risk; access-aware fan-out still needs app logic |
| MessagePack, per-message compression | Reject as defaults | Native JSON is faster; compression disables pre-encoded broadcast frames |
| Drizzle support in 5.0 | Defer | Every consumer is on Prisma 7; the storage adapter leaves the seam |

### From the URC throughput PR (#6517)

Its headline cache is bespoke: a tag-invalidated result cache welded to MikroORM, rewritten after nine amendments. Do not copy it. Also note that "10x" was the goal: the PR reports 3,737 requests per second at 20,000 users on 34 pods, with no matched before-and-after run on equal hardware.

Adopted from it: declared lean projections; per-method SQL and payload budget snapshots with a growth guard; access checks that take ids, memoize and batch; request-scoped dedupe; client invalidation dedupe; version catch-up on reconnect with the stamp read before the load; reads bounded by contract; lint baselines; the baseline-change-baseline benchmark protocol.

Its process lessons apply here: tests that copied production code could not fail; test and production booted differently; benchmark claims had to be corrected after review.

## 7. The existing 8-child pack

| Existing child | In v5 |
|---|---|
| 1. Non-overlapping invalidation | Kept (3.5) |
| 2. Singleflight | Kept, inside the method pipeline |
| 3. Serialize once and metrics | Kept, simpler: a JSON-only parser on both sides instead of a byte-identical encoder |
| 4. Capability handshake, cancellation, backpressure | Cancellation and backpressure kept. Capability negotiation is replaced by a version handshake plus a legacy shim |
| 5. Version-checked reads | Kept, and automatic where the framework owns the revision |
| 6. Push slimming | Kept. Patch deltas no longer need capability-gated sub-rooms |
| 7. Reconnect storm | Kept (3.4, 3.5) |
| 8. Release | Replaced by the migration and release pack |

The existing pack's constraint that a 4.x client must keep working against a 5.0 server is the source of most of its complexity. Dropping it is what the legacy shim and the reload-on-mismatch handshake are for.

## 8. Proposed packs

Seven packs, each landing its own PR on the `dev` branch. `main` stays on 4.1 until 5.0 is validated against quickdraw-chat and released. Story points are estimates. The design each pack implements is `0003-v5.md`.

| Pack | Contents | Points |
|---|---|---|
| A. Foundations | Design record; monorepo and toolchain; CI and release pipeline; unchanged 4.1 modules carried over with packaging fixed; benchmark harness with the 4.1 baseline recorded | 15 |
| B. Core runtime | Contracts; protocol v5; dispatcher and method pipeline; transports, server factory and legacy shim; MCP bridge | 21 |
| C. Data plane | Tracked writes; access control engine; projections and entity subscriptions; collections; whole-scope loading with index, views and change topics | 25 |
| D. Client | Typed client and provider; invalidation coordinator and optimistic mutations; live entities and collections; testing utilities | 18 |
| E. Kits | Read/write; search; sharing and membership; admin; presence, streams and channels; auth routes | 21 |
| F. Enforcement | Lint plugin; budgets, development warnings and observability; shipped agent rules and generated docs | 13 |
| G. Proof and release | Benchmark against the 4.1 baseline; codemod and migration guide; release candidate and downstream upgrade instructions; release 5.0.0 | 11 |

About 124 points in 32 children, against 26 for the existing pack.

Then one upgrade card per consumer, in this order: quickdraw-chat (reference), seneschal, x-tokage-siege, foundation, farseer, Conveyor. makiel (3.7) and quickdraw-sunfall (3.9.1) last, or left on 3.x.

## 9. Risks

- **Migration size.** 1,240 methods. Mitigation: the codemod, `no-v4-api`, and proving the guide on quickdraw-chat before any other app starts.
- **farseer** is the hardest migration despite being on 4.1.0: 279 methods, no collections, JSON access lists everywhere, a custom MCP registry.
- **Write tracking gaps** (raw SQL, nested writes). Mitigation in 3.2; the lint rules must land with the feature.
- **Conveyor's non-browser clients.** The legacy shim's scope must be confirmed against what the agent and runner clients actually call, including whether they subscribe.
- **Conveyor's board pack waits on 5.0.** Its plan already has an escape hatch: ship children 1 to 4 and detach 5 and 6. With a rebuild, taking the hatch is the right call.
- **Unverified:** the 2026-09-30 Conveyor numbers come from the board card; no diagnostics doc for that date exists in the Conveyor repo yet.

## 10. Owner decisions (2026-10-02)

1. Services are written as a declarative `defineService` object. No classes.
2. Clean wire break, with a legacy shim for 4.x request/response callers.
3. All four kits ship in 5.0, plus search and whole-board loading with clean live updates.
4. Conveyor is in no hurry. It waits for 5.0 and reshapes its board pack to match; no 4.2 stopgap.

5. v5 is built on a `dev` branch (created 2026-10-02 from `main` at `f767f68`). Release to `main` happens once every pack is done and quickdraw-chat has been migrated and validated against a release candidate.
