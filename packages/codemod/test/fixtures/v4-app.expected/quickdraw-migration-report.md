# quickdraw 5.0 migration report

Written by `@fitzzero/quickdraw-codemod` from the `// quickdraw-migrate: review` markers in the code; running the codemod again rewrites it from the markers that remain. Work through the sections in order (contracts, access, emits, client), delete each marker once its item is done, and see `MIGRATION.md` in `@fitzzero/quickdraw-core` for each kind of item. Then run lint (`no-v4-api` names every 4.x API left, `no-todo-schema` every placeholder) and the typecheck.

84 items in 24 files.

| Section | Items |
| --- | ---: |
| Contracts | 25 |
| Access | 8 |
| Access overrides to turn into a policy | 4 |
| toDto and protected fields to turn into projections and fields | 5 |
| Collections to declare in contracts | 2 |
| Hand emits to delete | 9 |
| this.create, this.update and this.delete to write through db | 4 |
| Raw SQL writes to record with ctx.touch | 1 |
| Lifecycle hooks | 1 |
| installAdminMethods to replace with the admin kit | 1 |
| Service instance state and the 4.x context | 1 |
| Client | 8 |
| Server wiring and other 4.x APIs | 15 |

## Contracts

Each method's kind was chosen from its name (get, list, search, find and count read). Inputs and outputs without a 4.x schema are `todoSchema` placeholders, which validate nothing; lint's `no-todo-schema` reports each one.

- [ ] `packages/shared/src/contracts/health.ts:10` query, since the web app reads it with useServiceQuery (its name reads as a mutation); input: todoSchema, as 4.x had no schema; output: todoSchema of the 4.x response type
- [ ] `packages/shared/src/contracts/health.ts:12` mutation, chosen from its name; input: todoSchema, as 4.x had no schema; output: todoSchema of the 4.x response type
- [ ] `packages/shared/src/contracts/label.ts:11` the entity is the 4.x DTO LabelDTO: give it a real schema. Its keys are the fields subscribers receive, read from model "label": drop any that is not a column, or give it a projection select and map
- [ ] `packages/shared/src/contracts/label.ts:14` query, chosen from its name; input: todoSchema, as 4.x had no schema
- [ ] `packages/shared/src/contracts/label.ts:16` mutation, chosen from its name; input: todoSchema, as 4.x had no schema
- [ ] `packages/shared/src/contracts/label.ts:18` query, chosen from its name
- [ ] `packages/shared/src/contracts/label.ts:20` mutation, chosen from its name; input: todoSchema, as 4.x had no schema; output: todoSchema of the 4.x response type
- [ ] `packages/shared/src/contracts/project.ts:22` the entity is the 4.x DTO ProjectDTO: give it a real schema. Its keys are the fields subscribers receive, read from model "project": drop any that is not a column, or give it a projection select and map
- [ ] `packages/shared/src/contracts/project.ts:25` mutation, chosen from its name; output: todoSchema of the 4.x response type
- [ ] `packages/shared/src/contracts/project.ts:27` query, chosen from its name
- [ ] `packages/shared/src/contracts/project.ts:29` mutation, chosen from its name
- [ ] `packages/shared/src/contracts/project.ts:31` query, chosen from its name
- [ ] `packages/shared/src/contracts/project.ts:33` mutation, chosen from its name; input: todoSchema, as 4.x had no schema; output: todoSchema of the 4.x response type
- [ ] `packages/shared/src/contracts/project.ts:35` mutation, chosen from its name; output: todoSchema of the 4.x response type
- [ ] `packages/shared/src/contracts/project.ts:37` query, chosen from its name; output: todoSchema of the 4.x response type
- [ ] `packages/shared/src/contracts/project.ts:39` mutation, chosen from its name; output: todoSchema of the 4.x response type
- [ ] `packages/shared/src/contracts/task.ts:23` the entity is the 4.x DTO TaskDTO: give it a real schema. Its keys are the fields subscribers receive, read from model "task": drop any that is not a column, or give it a projection select and map
- [ ] `packages/shared/src/contracts/task.ts:26` mutation, chosen from its name
- [ ] `packages/shared/src/contracts/task.ts:28` query, chosen from its name; output: todoSchema of the 4.x response type
- [ ] `packages/shared/src/contracts/task.ts:30` mutation, chosen from its name; input: todoSchema, as 4.x had no schema; output: todoSchema of the 4.x response type
- [ ] `packages/shared/src/contracts/task.ts:32` mutation, chosen from its name
- [ ] `packages/shared/src/contracts/task.ts:34` mutation, chosen from its name; input: todoSchema, as 4.x had no schema; output: todoSchema of the 4.x response type
- [ ] `packages/shared/src/contracts/user.ts:17` the entity is the 4.x DTO UserDTO: give it a real schema. Its keys are the fields subscribers receive, read from model "user": drop any that is not a column, or give it a projection select and map
- [ ] `packages/shared/src/contracts/user.ts:20` query, chosen from its name
- [ ] `packages/shared/src/contracts/user.ts:22` mutation, chosen from its name; output: todoSchema of the 4.x response type

## Access

The forms admit exactly the callers 4.x admitted. "Read" without a row id was open to every signed-in user; decide whether that was meant.

- [ ] `apps/api/src/services/label.ts:9` 4.x had no row-level access here (no hasEntryACL, no checkAccess): only service grants opened rows, which this empty policy keeps. Give it a real policy if rows belong to someone
- [ ] `apps/api/src/services/label.ts:19` 4.x's resolveEntryId was a function, kept here: where it returns nothing, the "" makes the row check fail, so only the service grant passes (4.x then applied the plain level)
- [ ] `apps/api/src/services/label.ts:26` "Read" with no row id let every signed-in user call this in 4.x, and "authenticated" keeps that; narrow it ({ service: "Read" }, { entry: "Read", id } or a scope form) if that was not meant
- [ ] `apps/api/src/services/project.ts:98` "Read" with no row id let every signed-in user call this in 4.x, and "authenticated" keeps that; narrow it ({ service: "Read" }, { entry: "Read", id } or a scope form) if that was not meant
- [ ] `apps/api/src/services/project.ts:127` "Read" with no row id let every signed-in user call this in 4.x, and "authenticated" keeps that; narrow it ({ service: "Read" }, { entry: "Read", id } or a scope form) if that was not meant
- [ ] `apps/api/src/services/task/methods/create-task.ts:9` "Read" with no row id let every signed-in user call this in 4.x, and "authenticated" keeps that; narrow it ({ service: "Read" }, { entry: "Read", id } or a scope form) if that was not meant
- [ ] `apps/api/src/services/task/methods/queries.ts:6` "Read" with no row id let every signed-in user call this in 4.x, and "authenticated" keeps that; narrow it ({ service: "Read" }, { entry: "Read", id } or a scope form) if that was not meant
- [ ] `apps/api/src/services/user.ts:40` "Read" with no row id let every signed-in user call this in 4.x, and "authenticated" keeps that; narrow it ({ service: "Read" }, { entry: "Read", id } or a scope form) if that was not meant

## Access overrides to turn into a policy

4.x decided row access in overridden methods; 5.0 decides it in the service's `access` policy, for every surface at once.

- [ ] `apps/api/src/services/task/index.ts:11` 4.x decided row access in checkEntryACL (now functions in this file): port them to a policy (owner, jsonAcl, members, inherit, anyOf or resolver). Until then this policy grants no row, so only service grants pass
- [ ] `apps/api/src/services/task/service-core.ts:22` 4.x access override: port it to the service's access policy (owner, jsonAcl, members, inherit, anyOf or resolver), then delete this function
- [ ] `apps/api/src/services/user.ts:20` 4.x access override: port it to the service's access policy (owner, jsonAcl, members, inherit, anyOf or resolver), then delete this function
- [ ] `apps/api/src/services/user.ts:36` 4.x decided row access in checkAccess (now functions in this file): port them to a policy (owner, jsonAcl, members, inherit, anyOf or resolver). Until then this policy grants no row, so only service grants pass

## toDto and protected fields to turn into projections and fields

Subscribers receive the contract's projections, built from rows, with field levels from the contract's `fields`.

- [ ] `apps/api/src/services/project.ts:49` 4.x toDto: subscribers now receive the contract entity's keys, projected from the row (dates as ISO strings); fold computed fields into a projection's select and map, then delete this function
- [ ] `apps/api/src/services/project.ts:61` protected fields: declare them in the contract's fields with the level that may read each one (fields: { email: "Admin" }), then delete this function
- [ ] `apps/api/src/services/task/service-core.ts:58` 4.x toDto: subscribers now receive the contract entity's keys, projected from the row (dates as ISO strings); fold computed fields into a projection's select and map, then delete this function
- [ ] `apps/api/src/services/user.ts:9` 4.x toDto: subscribers now receive the contract entity's keys, projected from the row (dates as ISO strings); fold computed fields into a projection's select and map, then delete this function
- [ ] `apps/api/src/services/user.ts:29` protected fields: declare them in the contract's fields with the level that may read each one (fields: { email: "Admin" }), then delete this function

## Collections to declare in contracts

A 4.x `defineCollection` becomes a contract collection (`scope`, `item`, `order`, and `index` plus `views` for boards) anchored in `defineService`.

- [ ] `apps/api/src/services/project.ts:21` 4.x collection "mine": declare it in the contract's collections (scope, item, order) and anchor it in defineService's collections, then delete this; it is no longer used
- [ ] `apps/api/src/services/task/service-core.ts:13` 4.x collection "byProject": declare it in the contract's collections (scope, item, order) and anchor it in defineService's collections, then delete this; it is no longer used

## Hand emits to delete

5.0 sends entity frames and collection deltas from tracked writes; room events become contract events.

- [ ] `apps/api/src/services/project.ts:69` hand emit: 5.0 sends collection deltas from tracked writes; write through db and let the tracked write emit, then delete this hand emit once the collection is declared in the contract
- [ ] `apps/api/src/services/project.ts:145` room event: declare it in the contract's events and send it with ctx.rooms.emit(room, contract, event, payload)
- [ ] `apps/api/src/services/project.ts:159` hand emit: 5.0 sends collection deltas from tracked writes; write through db and let the tracked write emit, then delete this hand emit once the collection is declared in the contract
- [ ] `apps/api/src/services/task/methods/create-task.ts:18` hand emit: 5.0 sends collection deltas from tracked writes; write through db and let the tracked write emit, then delete this hand emit once the collection is declared in the contract
- [ ] `apps/api/src/services/task/methods/queries.ts:28` hand emit: send a reset with qd.collections.reset(contract, collection, scope), if one is still needed
- [ ] `apps/api/src/services/task/methods/update-task.ts:12` hand emit: 5.0 sends entity frames from tracked writes; delete this once the write goes through db
- [ ] `apps/api/src/services/task/methods/update-task.ts:25` hand emit: 5.0 sends entity frames from tracked writes; delete this once the write goes through db
- [ ] `apps/api/src/services/task/methods/update-task.ts:27` hand emit: 5.0 sends collection deltas from tracked writes; write through db and let the tracked write emit, then delete this hand emit once the collection is declared in the contract
- [ ] `apps/api/src/services/user.ts:61` hand emit: 5.0 sends entity frames from tracked writes; delete this once the write goes through db

## this.create, this.update and this.delete to write through db

The 4.x CRUD helpers also emitted and ran lifecycle hooks; `db.<model>` writes are tracked and throw on failure.

- [ ] `apps/api/src/services/project.ts:101` 4.x CRUD helper this.create: it also emitted the entity and collection deltas and ran the lifecycle hooks. Write db.project.create(...) instead (frames follow the tracked write; hooks do not run; db.create throws on failure)
- [ ] `apps/api/src/services/project.ts:121` 4.x CRUD helper this.update: it also emitted the entity and collection deltas and ran the lifecycle hooks. Write db.project.update(...) instead (frames follow the tracked write; hooks do not run; 4.x returned null for a missing row where db.update throws NOT_FOUND)
- [ ] `apps/api/src/services/project.ts:143` 4.x CRUD helper this.update: it also emitted the entity and collection deltas and ran the lifecycle hooks. Write db.project.update(...) instead (frames follow the tracked write; hooks do not run; 4.x returned null for a missing row where db.update throws NOT_FOUND)
- [ ] `apps/api/src/services/project.ts:155` 4.x CRUD helper this.delete: it also emitted the entity and collection deltas and ran the lifecycle hooks. Write db.project.delete(...) instead (frames follow the tracked write; hooks do not run; 4.x returned false for a missing row where db.delete throws NOT_FOUND)

## Raw SQL writes to record with ctx.touch

Tracked writes cannot see raw SQL; `ctx.touch(model, ids)` records the rows it changed (lint: `no-raw-sql-write`).

- [ ] `apps/api/src/services/task/methods/queries.ts:25` raw SQL write: tracked writes cannot see it, so subscribers would miss it; record the rows with ctx.touch(model, ids), or reset a scope with qd.collections.reset (lint: no-raw-sql-write)

## Lifecycle hooks

Hooks ran only inside the CRUD helpers; move their work into the methods that write.

- [ ] `apps/api/src/services/project.ts:67` 4.x lifecycle hook, run only by this.create: move what it does into the methods that create rows (or affects, for rows of other services), then delete it

## installAdminMethods to replace with the admin kit

`admin.contract({ entity })` and `admin.handlers(contract, options)`.

- [ ] `apps/api/src/services/project.ts:29` installAdminMethods: use the admin kit (...admin.contract({ entity }) in the contract, ...admin.handlers(contract, { displayName, hiddenFields, fieldOverrides }) in methods), then delete this; it is no longer used

## Service instance state and the 4.x context

A service is an object now: no constructor, no fields, no `this`; handlers read `ctx.principal`.

- [ ] `apps/api/src/services/task/methods/queries.ts:9` inline auth guard: the access form already requires a principal, so the !ctx.principal.userId part never holds; drop it (lint: no-inline-auth-guard)

## Client

Hook calls now go through the typed client (`qd.<service>.<member>`); these need a decision.

- [ ] `apps/web/src/components/AdminCount.tsx:8` this 4.x hook call was not converted: it names the service or method at run time. Call the typed client's member (qd.<service>.<method>) instead
- [ ] `apps/web/src/components/Members.tsx:7` invalidateOn is gone: give the query a watch in its contract entry (it is fetched again when that collection scope changes), or read a collection
- [ ] `apps/web/src/components/Members.tsx:13` room events: declare them in the contract's events and listen with qd.<service>.<event>.useEvent(handler)
- [ ] `apps/web/src/components/ProjectList.tsx:14` onError receives a QuickdrawError now (4.x passed the message string): read error.message or error.code
- [ ] `apps/web/src/components/TaskBoard.tsx:7` compare is gone: items follow the contract collection's order (put the sort there)
- [ ] `apps/web/src/components/TaskBoard.tsx:15` manual refetch: live data, watch and the invalidation coordinator keep quickdraw queries current; delete it, or give the query a watch
- [ ] `apps/web/src/hooks/useMyProjects.ts:16` compare is gone: items follow the contract collection's order (put the sort there)
- [ ] `apps/web/src/providers.tsx:7` 4.x QuickdrawProvider props (serverUrl, authToken, autoConnect): 5.0 takes client={qd} (lib/quickdraw), url, auth and socketOptions

## Server wiring and other 4.x APIs

What lint's `no-v4-api` also reports, each with its replacement: the server set-up, room helpers, removed types.

- [ ] `apps/api/src/index.ts:4` 4.x API ServiceRegistry (removed): lint's no-v4-api names each replacement
- [ ] `apps/api/src/index.ts:17` the 4.x service was constructed here (new ProjectService(...)): it is the object projectService now; pass it in qd.createServer({ services: [...] })
- [ ] `apps/api/src/index.ts:19` the 4.x service was constructed here (new TaskService(...)): it is the object taskService now; pass it in qd.createServer({ services: [...] })
- [ ] `apps/api/src/index.ts:21` the 4.x service was constructed here (new UserService(...)): it is the object userService now; pass it in qd.createServer({ services: [...] })
- [ ] `apps/api/src/index.ts:23` the 4.x service was constructed here (new LabelService(...)): it is the object labelService now; pass it in qd.createServer({ services: [...] })
- [ ] `apps/api/src/index.ts:25` the 4.x service was constructed here (new HealthService(...)): it is the object healthService now; pass it in qd.createServer({ services: [...] })
- [ ] `apps/api/src/services/project.ts:8` 4.x API CollectionSnapshotPage (removed): lint's no-v4-api names each replacement
- [ ] `apps/api/src/services/shared/guards.ts:1` 4.x API ServiceMethodContext (removed): lint's no-v4-api names each replacement
- [ ] `apps/api/src/services/task/service-core.ts:3` 4.x API CollectionSnapshotPage (removed): lint's no-v4-api names each replacement
- [ ] `apps/api/src/services/user.ts:4` 4.x API QuickdrawSocket (moved): lint's no-v4-api names each replacement
- [ ] `apps/web/src/components/AdminCount.tsx:3` 4.x API useServiceQuery (removed): lint's no-v4-api names each replacement
- [ ] `apps/web/src/hooks/index.ts:3` 4.x API useRoomEvents (removed): lint's no-v4-api names each replacement
- [ ] `apps/web/src/hooks/useMyProjects.ts:3` 4.x API useQuickdrawSocket (removed): lint's no-v4-api names each replacement
- [ ] `packages/shared/src/events.ts:4` QuickdrawEventMap typed 4.x room events: declare each event in its contract (events: { name: { payload } }), send it with ctx.rooms.emit and listen with qd.<service>.<event>.useEvent, then delete this augmentation
- [ ] `packages/shared/src/index.ts:4` 4.x API serviceRoom (removed): lint's no-v4-api names each replacement
