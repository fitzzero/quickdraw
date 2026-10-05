# farseer: upgrade brief

On 4.1.0. The largest migration after Conveyor and, by the audit, the
hardest: plan it as its own pack, fourth in line.

## Size

22 services and 279 methods, no collections; JSON access lists throughout,
a custom MCP registry with token scopes, 63 manual `refetch()` calls, 92
inline auth guards, and 55 raw Prisma writes in services against 5 through
the framework (the audit of 2026-10-02). Run the codemod's dry run for the
report's counts before planning.

## Top hazards

1. **The service-grant workaround.** farseer patched 4.x's open default (a
   `"Read"` method without a row id admitted every signed-in user) in app
   code, `apps/api/src/utils/acl.ts:58-77`. The codemod maps access as 4.x's
   framework admitted it, so where the workaround narrowed that, the
   codemod's marked `"authenticated"` forms are wider than farseer's actual
   rule. Read the workaround first, write each method's form from it (the
   dual-threshold `{ service: L1, entry: L2 }` where it emulated separate
   service and row levels), then delete it. A method that takes an `id`
   under a form that checks no row is refused at startup until decided.
2. **JSON access lists everywhere.** Each service gets a `jsonAcl` policy
   on its list column (with its owner column), and share and unshare
   methods move to the sharing kit. 5.0 reads the lists strictly: a
   malformed list denies (`FORBIDDEN`), the sharing kit refuses to change
   it (`CONFLICT`), the kit's levels are `Read`, `Moderate` and `Admin`,
   and a user listed twice gets the highest of their levels (4.x took the
   first; the codemod marks each `jsonAcl`). Check the stored lists' shape
   in the database before the cutover.
3. **The custom MCP registry with token scopes.** It moves onto the bridge
   (`createMcpRegistry` in `./server/mcp`): a `principal` hook turns the
   token into a principal, and scopes become access forms or `custom`
   checks. 5.0 does not filter `tools/list` per principal (RFC 0003,
   section 17), so tools a scope used to hide are listed to every client;
   calls are still refused.
4. **63 manual `refetch()` calls and no collections.** `no-manual-refetch`
   finds them. Each becomes a contract `watch` (a collection's scope, or
   the service's topic narrowed to the models the query reads,
   `watch: { service: ["note"] }`), an entity subscription (`useEntity`),
   or a collection for a list that should be live; choose the lists to make
   collections before porting the screens.
5. **92 inline auth guards.** `if (!ctx.userId) throw` becomes declared
   access; the codemod drops a guard only where 4.x already refused
   anonymous callers, and `no-inline-auth-guard` reports the rest. Its REST
   routes take `requireSession` and `sessionOf`, and call services as
   `qd.caller(principal)`, which loads the user's grants.

## Suggested order

1. Access design, reviewed before code moves: the workaround read, the
   forms written per method, the stored access lists checked.
2. The codemod and lint with a baseline, then contracts and access in
   clusters of services, one child card per cluster, an access matrix each.
3. Writes through `db` (55 raw writes) per cluster.
4. The MCP registry onto the bridge.
5. The client: the refetch calls, the new collections, the guards gone.
6. Budgets for the busiest screens; `legacyWire: true` while any other
   4.x client remains.
