---
paths:
  - "apps/api/**"
  - "packages/shared/**"
---

# quickdraw 5.0: access control

> From `@fitzzero/quickdraw-skills` (`quickdraw-skills link`). `paths` follow
> the quickdraw template: contracts in `packages/shared`, the server in
> `apps/api`. Another layout replaces this link with a copy and edits them.

Access is declared, never coded inline, and everything fails closed: a
method without `access` does not compile, and a missing row, a missing id, an
unknown level or a malformed access list denies.

## Who may call a method

Every method's `{ access, handler }` names one form:

| Form                              | Passes when                                                                                                                        |
| --------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------- |
| `"public"`                        | always, with or without a principal                                                                                                |
| `"authenticated"`                 | a principal exists                                                                                                                 |
| `{ service: L }`                  | the principal's service-wide grant is at least `L`                                                                                 |
| `{ entry: L, id? }`               | the policy gives the principal at least `L` on the row (`id` defaults to `input.id`)                                               |
| `{ service: L1, entry: L2, id? }` | either of the two                                                                                                                  |
| `{ scope: L, of: contract, id }`  | at least `L` on a row of another service, whose id is `input[id]` (create and list methods)                                        |
| `custom((ctx, input) => boolean)` | the function resolves `true` (a principal is required first); it replaces the row check, and a service-wide `Admin` grant skips it |

- Levels are `"Read" < "Moderate" < "Admin"` (`AccessLevel` also has
  `"Public"`). `id` is an input key (type-checked) or a function of the input.
- Without a principal every form but `"public"` answers `UNAUTHENTICATED`; a
  principal that fails gets `FORBIDDEN`. In a `"public"` handler
  `ctx.principal` may be `null`; under every other form it is not.
- Never guard inline (`if (!ctx.principal) throw ...`): declare the form. The
  `no-inline-auth-guard` lint rule reports it.

## Which kinds of principal may call

An app whose principals come in kinds (`principal.kind`: a user, an agent's
token, a runner) declares which kinds may call with `kinds`, beside `access`,
never inside a form:

```ts
export const qd = initQuickdraw<{ db: typeof db; principal: AppPrincipal }>({
  kinds: ["user", "agent"], // every service, unless it narrows them
});

export const tokenService = qd.defineService(token, {
  kinds: ["user", "agent"], // its methods, subscriptions and channels
  methods: {
    mint: { access: "authenticated", kinds: ["user"], handler: mint }, // this method alone
    heartbeat: { access: "authenticated", handler: beat }, // the service's kinds
  },
});
```

- Each level only narrows the one above it: a method's list within its
  service's, a service's within the app's. The types refuse a name that is
  no kind of the app's principal, and `defineService` refuses a wider or
  empty list when the service is defined.
- A principal of another kind, or without a `kind`, gets `FORBIDDEN` before
  the form is asked. No grant passes the check, a service-wide `Admin` grant
  included: a token acting with its user's grants is what it stops.
- An anonymous caller is left to the form (`UNAUTHENTICATED` wherever it
  needs a principal). So a `"public"` method takes no `kinds` of its own: a
  caller of a refused kind would call it signed out. It keeps its service's
  list, which holds for signed-in callers.
- A service's list also refuses other kinds on `qd:sub`, `qd:col:sub`,
  `qd:watch` and `qd:stream:sub`, and its channels drop their messages.
- Kinds separate only what the hooks label: label an MCP caller
  `kind: "agent"` in the bridge's `principal` hook (`bearerAuth` with
  `loadPrincipal: (userId) => ({ userId, kind: "agent" })`), or a method
  with `kinds: ["user"]` lets it in as a user. An MCP custom tool obeys the
  app's kinds too, and takes `kinds` of its own within them, never a kind
  check in its handler.
- Never check the kind in a handler (`if (ctx.principal.kind !== "user")
throw ...`; `no-inline-auth-guard` reports it) or in a `custom` form:
  `kinds` combines with any form (`{ entry: "Moderate" }` and
  `kinds: ["user"]`), where `custom` would have to check the row by hand.
  A check on a claim, such as a token's `scope`, is `claims`, never
  `custom` (below).

## A requirement on the caller's claims

A check on the caller's verified claims (`principal.claims`, a token's
`scope`) is `claims`, beside `access` on the method:

```ts
triage: {
  // Moderate on the task's project, from a token that may triage: claims add to the form
  access: { entry: "Moderate" },
  claims: (claims, input) => claims?.scope === "triage" && input.status !== "archived",
  handler: ({ input, db }) =>
    db.task.update({ where: { id: input.id }, data: { status: input.status } }),
},
```

- It adds to the form: `triage` needs Moderate on the task's project and a
  triage token. Never write it as `custom`: that form replaces the row
  check, so any token holding the claim would write every tenant's rows,
  and a service-wide `Admin` grant skips it.
- It runs right after `kinds`, outside the access engine, so no grant passes
  it, a service-wide `Admin` grant included. Without a principal the call
  is `UNAUTHENTICATED`; when it returns anything but `true`, `FORBIDDEN`.
- It is synchronous, and a `"public"` method takes none.
- A token narrowed by `claims` is narrowed only on the methods that declare
  it; elsewhere it acts with its user's grants (`kinds` keeps a kind of
  token out).

## A row the form cannot name

A check of the caller's level on a row no declared form names (a parent
the input names, a key that is optional) is a `custom` form that asks
`ctx.access`: never a check in the handler, and never a module that holds
the dispatcher.

```ts
assigned: {
  // Read on the project the input names, asked through ctx.access; none named, the caller's
  // own that they may still read
  access: custom(
    async (ctx, input) =>
      input.projectId === undefined || (await ctx.access.can(project, input.projectId, "Read")),
  ),
  handler: async ({ input, ctx, db }) => {
    const readable = await ctx.access.where(task, "Read");
    if (readable === "none") return [];
    return db.task.findMany({
      where: { AND: [{ assigneeId: ctx.principal.userId, projectId: input.projectId }, readable] },
      take: 100,
    });
  },
},
```

- `ctx.access.can(service, id, level)`, `levelsFor(service, ids)` and
  `where(service, level)` count levels as `{ entry }` does, for
  `ctx.principal` with the grants the call runs with: never load the user's
  grants again. `service` is a contract or a service name.
- A list the form lets through without its key still follows the row
  policy: add `ctx.access.where(service, "Read")` to its `findMany` with
  `AND` (`"none"` lists nothing). Never spread it into `where`: a filter on
  the same column (`inherit`'s `projectId`) replaces the input's, and the
  keyed list widens to every row the caller reads.
- Prefer a declared form when one says it: `{ entry: L }` for the method's
  own row, `{ scope: L, of, id }` for a parent whose key is always there.
  A `ctx.access` form counts a service-wide `Admin` grant on the service it
  asks (the parent's), which `{ scope, of }` does not: it counts only one
  on the method's own service. `custom` replaces the row check and a
  service-wide `Admin` grant skips it, so a method whose input has `id`
  still needs `rowless: true` beside it (below).
- An anonymous caller has no level anywhere (`false`, an empty map,
  `"none"`). `qd` has no `access`: a job asks `server.dispatcher.access`.

## A method that takes a row id

On a service with a policy, a method whose input has `id` reads or writes
the row that id names. Under a form that asks the policy nothing about that
row, anyone the form admits reaches any row by its id, so `defineService`
refuses it when the service is defined. Those forms are the ones that check
no row (`"public"`, `"authenticated"`, `{ service: L }` below `Admin`),
`custom(fn)`, `{ scope, of, id }` (a row of another service) and
`{ entry, id }` naming another key. Fix the form, not the error:

- Give it `{ entry: L }` (`"Read"` for a read, `"Moderate"` for a change),
  or `{ service: L, entry: L }` to keep a service grant: the policy decides.
- Only when every caller the form admits may reach any row on purpose (a
  public profile, a lookup by an id that tells nothing), or when `id` names
  a row the method creates (an id the client made, under a `scope` form),
  say so with `rowless: true` on the method, or `rowless: ["get"]` in a
  kit's options (`crud.handlers`, `admin.handlers`, `sharing.handlers`). A
  `rowless` query under a form that checks no row also answers "not
  modified" for any `id`.
- The read/write kit's `update`, `delete` and `reorder` check the row
  themselves and need neither. `create` makes a new row and checks no row of
  its own: it checks the anchors it writes (each `inherit` parent and
  anchored collection's scope column, from what `prepare` returns) at the
  method's row level, and takes a column the policy reads only from
  `prepare` (`ownerId: ctx.principal.userId`), unless the caller holds a
  service-wide `Admin` grant. Give it
  `{ scope: "Moderate", of: project, id: "projectId" }`.
- The check reads the input's keys from its JSON Schema: an `id` in any
  branch of a union counts, as does one beside a `Date` or a `Set`. An input
  without JSON Schema (a Zod 3 schema) or one that names no keys (a
  `todoSchema` without `keys`), a bare string that is the id itself, a row
  named by another key (`taskId`, `ids`) on an input without `id`, and an
  `entry` form whose `id` is a function are not checked, so the form is all
  yours there (`{ entry: L, id: "taskId" }` names another key).

## Service-wide grants

`principal.serviceAccess` holds grants by service name,
`{ taskService: "Admin" }`: returned by `authenticate`, or loaded by
`createServer({ auth: { loadServiceAccess } })` for a principal that
carries none: at a socket's handshake, for each HTTP call, and for an
in-process caller (`qd.caller(principal)`, `server.dispatcher.caller`) at
its first call. With
`auth.serviceAccessSource: { model: "user", column: "serviceAccess" }`, a
tracked write to that column refreshes the user's open sockets, and an
in-process caller loads the grants again at its next call.

- A service-wide `Admin` grant passes every access form on its service
  (`adminBypass: false` on the service turns that off), though not `kinds`
  or `claims`.
- A grant below `Admin` counts only where the form names `service`: a `Read`
  grant does not read every row through an `entry` form.

## Row policies

The service's `access` option says how a principal's level on one of its rows
is found. Column and model names are checked against the Prisma client at
compile time.

| Policy                                                 | Level from                                      |
| ------------------------------------------------------ | ----------------------------------------------- |
| `owner("ownerId")`                                     | `Admin` when the column is the user's id        |
| `jsonAcl("acl", { owner: "ownerId" })`                 | a `[{ userId, level }]` JSON column, plus owner |
| `members({ model, entry, user, level, levels? })`      | a membership table row                          |
| `inherit({ from: projectContract, via: "projectId" })` | the level on the parent row in another service  |
| `anyOf(policyA, policyB)`                              | the highest level any of them gives             |
| `resolver({ levelsFor, where?, reads })`               | your code, one batched read for all ids         |
| `everyone("Read")`                                     | every signed-in user, on every row; no read     |

- `entry` forms need a policy and `scope` forms a `model`; a service without
  a model may use only `"public"`, `"authenticated"`, `{ service }` and
  `custom`.
- `inherit` uses the parent's policy only: grants on the parent's service do
  not flow down.
- Rows everyone signed in may read (public profiles) take
  `anyOf(owner("id"), everyone("Read"))`, never a hand-written `resolver`
  answering `Read` for every id: `rowless: true` covers one method, not
  subscriptions.
- A `resolver` declares what its levels depend on, or nothing re-checks it
  and a removed member keeps their live rows:
  `reads: { columns: ["visibility"], memberships: [{ model: "teamMember", entry: "projectId", user: "userId", level: "role" }] }`
  (columns of the service's model; membership tables as `members` takes
  them, `entry` holding this service's row id). Tracked writes to them then
  revoke and re-check as for the other policies, and `tools.rows(ids)` reads
  the declared columns. `reads: "none"` only when nothing a tracked write
  changes can change a level (the principal's grants alone). Without either
  the server warns `[quickdraw:resolver-without-reads]` and a strict test
  app fails to start. A level from another service's row is `inherit`'s
  job, alone or in `anyOf`.
- Lookups are batched per call: checking 60 ids costs what one does.
  `createServer({ access: { cacheMs } })` keeps them across calls; tracked
  writes to the columns and tables a policy reads evict them. A lookup
  inside a transaction always reads the database.
- Membership and junction tables need an `id` column
  (`id String @id @default(cuid())`, the pair unique by `@@unique`), never a
  composite `@@id`: the write tracker keys rows by `id`, so such a table is
  never tracked and a removed member is never revoked. `createServer` logs
  `[quickdraw:untracked-access-model]` as an error for one, and a strict
  test app fails to start. A foreign key set through a relation on the
  written row (`task.update({ data: { project: { connect } } })`) revokes
  like a scalar one; one set from the parent's side
  (`project.update({ data: { tasks: { connect } } })`) is a nested write
  whose rows are not tracked: write the foreign key on the row itself.
- Never pass Socket.IO's `connectionStateRecovery` in `createServer({ socket })`:
  a recovered socket comes back with its principal and rooms without
  authenticating again, so a revoked session or a lowered grant would
  return. `createServer` refuses it; clients resume by revision on every
  reconnect.

## One policy, every surface

The same policy decides method calls, entity subscriptions (`useEntity`),
collection scopes (through the collection's `anchor`), the rows the kits'
`list`, `getMany`, `search` and bulk methods return or write, streams and
channel `requires`.

- Everyone who may open an anchored collection scope sees every item in it,
  stripped at the collection's `access` level (default `Read`). Per-row
  policies and field tiers do not apply inside an anchored scope: give the
  item service `inherit` from the anchor, or use separate scopes. A self
  scope (`scopeAccess: "self"`) is the exception: its items follow the item
  service's policy, so its user gets only the rows they may read.
- A list whose methods need a service-wide grant (`{ service: "Read" }`)
  needs it too: `requires: { service: "Read" }` beside its `anchor` or
  `scopeAccess`, in `defineService`'s `collections`. Both checks apply (a
  service-wide `Admin` passes either), a scope without the grant is
  `FORBIDDEN`, and a reload of the user's grants below it revokes the scope
  on their sockets. Without it a self list opens for any signed-in user.
- A hand-written method that reads many rows authorizes the parent
  (`{ scope: "Read", of: project, id: "projectId" }`) and filters by it, or
  uses the read/write kit's `list` or a collection, which filter by policy.
- `fields: { notes: "Admin" }` in the contract strips a field from callers
  below that level on the row, in replies and in live frames, so the row
  types a client reads (`useEntity`, collection items, `"entity"` outputs,
  `EntityOf`) make it optional: read it with a guard. A handler may return
  the whole row; only the output's keys are sent. A projection output
  (`"entity"`, a named projection, `nullable(...)`, `listOf(...)`) is
  stripped per caller; a method's own output schema sends the keys it
  declares to every caller the method admits. So never declare a tiered
  field in a method's own output schema, at any depth
  (`output: z.object({ id, email })`, `z.object({ user: userSchema })`):
  answer `"entity"` or a projection instead. The server warns
  `[quickdraw:tiered-field-in-output]` when it starts, and a strict test
  app fails to start.
- The service's change topic (`qd:watch` on `"service"`) is closed unless
  the service declares `watchAccess` (`"public"`, `"authenticated"` or
  `{ service: L }`). A stream without `access` in its contract is closed.
  A channel takes `{ access: { service: L }, handler }` on the service and
  `requires: { entity } | { collection, scope } | { room }` in the contract;
  `{ room }` admits only a socket a method joined to that app room, so the
  method's access decides who may send.

## Changing access

- Change access lists and memberships with the sharing kit
  (`sharing.contract({ mode: "acl" | "members" })`), which refuses granting
  above the caller's own level, changing or removing a user above it (equal
  may; roles that map to one level are peers, so protect an owner with an
  owner column), and removing the last `Admin`. Its `resolveUser` returns
  exactly one user or `null`: an email with `findUnique`, a name only when
  `findMany({ where: { name }, take: 2 })` finds one; never `findFirst` by
  name. Without a
  service-wide `Admin` grant, the read/write and admin kits refuse a
  membership table's entry, user and role columns, whichever policy reads
  them. They also refuse a column the policy reads. That holds even for a
  column an anchored collection scopes by.
- Give a bulk method (`bulkUpdate`, `bulkDelete`) a form with a row level,
  or the same form as `update` or `delete`: under a form that names none,
  it takes the counterpart's row level only from an `{ entry: L }` form.
- Write policy columns and membership rows through the tracked `db`: the
  flush then revokes what a demoted user held (`qd:revoked`), moves them to
  their new field tier, and updates `via` collections. A write the tracked
  client cannot see needs `ctx.touch`, or the revocation never happens.

## Testing

Pin every service's matrix with `describeAccessMatrix` from
`@fitzzero/quickdraw-core/testing` (see quickdraw-testing.md): each method
as owner, member, stranger and anonymous, through the real dispatcher, and
on a service with `kinds`, as a principal of each kind it refuses (each
cell records its principal's `kind`). Before changing a form, a policy or
the kinds of principal, record the whole table with `snapshotAccessMatrix`
(every method, entity subscribe and collection scope, in
`__access__/<test file>.json`): each cell the change moves then fails,
saying whether it opens or closes access, until
`QD_UPDATE_ACCESS_SNAPSHOT=1` accepts it.
