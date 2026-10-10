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

| Form                              | Passes when                                                                                 |
| --------------------------------- | ------------------------------------------------------------------------------------------- |
| `"public"`                        | always, with or without a principal                                                         |
| `"authenticated"`                 | a principal exists                                                                          |
| `{ service: L }`                  | the principal's service-wide grant is at least `L`                                          |
| `{ entry: L, id? }`               | the policy gives the principal at least `L` on the row (`id` defaults to `input.id`)        |
| `{ service: L1, entry: L2, id? }` | either of the two                                                                           |
| `{ scope: L, of: contract, id }`  | at least `L` on a row of another service, whose id is `input[id]` (create and list methods) |
| `custom((ctx, input) => boolean)` | the function resolves `true` (a principal is required first)                                |

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
- Never check the kind in a handler (`if (ctx.principal.kind !== "user")
throw ...`; `no-inline-auth-guard` reports it) or in a `custom` form:
  `kinds` combines with any form (`{ entry: "Moderate" }` and
  `kinds: ["user"]`), where `custom` would have to check the row by hand.
  A check on a claim, such as a token's `scope`, stays `custom`.

## A method that takes a row id

On a service with a policy, a method whose input has `id` reads or writes
the row that id names. Under a form that checks no row (`"public"`,
`"authenticated"`, `{ service: L }` below `Admin`), anyone the form admits
reaches any row by its id, so `defineService` refuses it when the service is
defined. Fix the form, not the error:

- Give it `{ entry: L }` (`"Read"` for a read, `"Moderate"` for a change),
  or `{ service: L, entry: L }` to keep a service grant: the policy decides.
- Only when every caller the form admits may reach any row on purpose (a
  public profile, a lookup by an id that tells nothing) say so with
  `rowless: true` on the method, or `rowless: ["get"]` in a kit's options
  (`crud.handlers`, `admin.handlers`, `sharing.handlers`).
- The read/write kit's `update`, `delete`, `reorder` and `create` check the
  row themselves and need neither.
- The check reads the input's keys from its JSON Schema: an `id` in any
  branch of a union counts, as does one beside a `Date` or a `Set`. An input
  without JSON Schema (a Zod 3 schema) or one that names no keys (a
  `todoSchema` without `keys`), a bare string that is the id itself
  and a row named by another key (`taskId`, `ids`) are not checked, so the
  form is all yours there (`{ entry: L, id: "taskId" }` names another key).

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

- A service-wide `Admin` grant passes every check on its service
  (`adminBypass: false` on the service turns that off).
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
  writes to the columns and tables a policy reads evict them.

## One policy, every surface

The same policy decides method calls, entity subscriptions (`useEntity`),
collection scopes (through the collection's `anchor`), the rows the kits'
`list`, `getMany`, `search` and bulk methods return or write, streams and
channel `requires`.

- Everyone who may open a collection scope sees every item in it, stripped
  at the collection's `access` level (default `Read`). Per-row policies and
  field tiers do not apply inside a collection: give the item service
  `inherit` from the anchor, or use separate scopes.
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
  above the caller's own level and removing the last `Admin`.
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
