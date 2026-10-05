# quickdraw 5.0 migration report

Written by `@fitzzero/quickdraw-codemod` from the `// quickdraw-migrate: review` markers in the code; running the codemod again rewrites it from the markers that remain. Work through the sections in order (contracts, access, emits, client), delete each marker once its item is done, and see the migration guide (`MIGRATION.md`, shipped in `@fitzzero/quickdraw-codemod`) for each kind of item. Then run lint (`no-v4-api` names every 4.x API left, `no-todo-schema` every placeholder) and the typecheck.

125 items in 27 files.

| Section                                                        | Items |
| -------------------------------------------------------------- | ----: |
| Contracts                                                      |    28 |
| Access                                                         |    10 |
| Access overrides to turn into a policy                         |     4 |
| toDto and protected fields to turn into projections and fields |     5 |
| Collections to declare in contracts                            |     2 |
| Hand emits to delete                                           |     9 |
| this.create, this.update and this.delete to write through db   |     4 |
| Raw SQL writes to record with ctx.touch                        |     1 |
| Lifecycle hooks                                                |     1 |
| installAdminMethods to replace with the admin kit              |     1 |
| Methods a kit implements                                       |     9 |
| Service instance state and the 4.x context                     |    12 |
| Errors the caller no longer sees                               |     5 |
| Client                                                         |    11 |
| Server wiring and other 4.x APIs                               |    22 |
| Carve-outs                                                     |     1 |

## Contracts

Each method's kind was chosen from its name (get, list, search, find and count read). Inputs and outputs without a 4.x schema are `todoSchema` placeholders, which validate nothing; lint's `no-todo-schema` reports each one.

- [ ] `apps/api/src/services/project.ts:122` the contract's output is "entity" (4.x answered ProjectDTO | null): return the row, and let a missing one fail with NOT_FOUND (db.<model>.update throws it)
- [ ] `apps/api/src/services/task/methods/update-task.ts:7` the contract's output is "entity" (4.x answered TaskDTO | null): return the row, and let a missing one fail with NOT_FOUND (db.<model>.update throws it)
- [ ] `packages/shared/src/contracts/health.ts:10` query, since the web app reads it with useServiceQuery (its name reads as a mutation); input: todoSchema, as 4.x had no schema; output: todoSchema of the 4.x response type
- [ ] `packages/shared/src/contracts/health.ts:12` mutation, chosen from its name; input: todoSchema, as 4.x had no schema; output: todoSchema of the 4.x response type
- [ ] `packages/shared/src/contracts/label.ts:12` the entity is the 4.x DTO LabelDTO: give it a real schema. Its keys are the fields subscribers receive, read from model "label": drop any that is not a column, or give it a projection select and map
- [ ] `packages/shared/src/contracts/label.ts:15` query, chosen from its name; input: todoSchema, as 4.x had no schema
- [ ] `packages/shared/src/contracts/label.ts:17` mutation, chosen from its name; input: todoSchema, as 4.x had no schema
- [ ] `packages/shared/src/contracts/label.ts:19` query, chosen from its name
- [ ] `packages/shared/src/contracts/label.ts:21` mutation, chosen from its name; input: todoSchema, as 4.x had no schema; output: todoSchema of the 4.x response type
- [ ] `packages/shared/src/contracts/project.ts:22` the entity is the 4.x DTO ProjectDTO: give it a real schema. Its keys are the fields subscribers receive, read from model "project": drop any that is not a column, or give it a projection select and map
- [ ] `packages/shared/src/contracts/project.ts:35` mutation, chosen from its name; output: todoSchema of the 4.x response type
- [ ] `packages/shared/src/contracts/project.ts:37` query, chosen from its name
- [ ] `packages/shared/src/contracts/project.ts:39` mutation, chosen from its name; output: "entity", where 4.x answered ProjectDTO | null (null for a missing row, which a tracked write answers with NOT_FOUND instead); only an exact "entity" output is optimistic by default. Use nullable("entity") if the handler still answers null
- [ ] `packages/shared/src/contracts/project.ts:41` query, chosen from its name
- [ ] `packages/shared/src/contracts/project.ts:43` mutation, chosen from its name; input: todoSchema, as 4.x had no schema; output: todoSchema of the 4.x response type
- [ ] `packages/shared/src/contracts/project.ts:45` mutation, chosen from its name; output: todoSchema of the 4.x response type
- [ ] `packages/shared/src/contracts/project.ts:47` query, chosen from its name; output: todoSchema of the 4.x response type
- [ ] `packages/shared/src/contracts/project.ts:49` mutation, chosen from its name; output: todoSchema of the 4.x response type
- [ ] `packages/shared/src/contracts/task.ts:23` the entity is the 4.x DTO TaskDTO: give it a real schema. Its keys are the fields subscribers receive, read from model "task": drop any that is not a column, or give it a projection select and map
- [ ] `packages/shared/src/contracts/task.ts:26` mutation, chosen from its name
- [ ] `packages/shared/src/contracts/task.ts:28` query, chosen from its name; output: todoSchema of the 4.x response type
- [ ] `packages/shared/src/contracts/task.ts:30` mutation, chosen from its name; input: todoSchema, as 4.x had no schema; output: todoSchema of the 4.x response type
- [ ] `packages/shared/src/contracts/task.ts:32` mutation, chosen from its name; output: "entity", where 4.x answered TaskDTO | null (null for a missing row, which a tracked write answers with NOT_FOUND instead); only an exact "entity" output is optimistic by default. Use nullable("entity") if the handler still answers null
- [ ] `packages/shared/src/contracts/task.ts:34` mutation, chosen from its name; input: todoSchema, as 4.x had no schema; output: todoSchema of the 4.x response type
- [ ] `packages/shared/src/contracts/user.ts:17` the entity is the 4.x DTO UserDTO: give it a real schema. Its keys are the fields subscribers receive, read from model "user": drop any that is not a column, or give it a projection select and map
- [ ] `packages/shared/src/contracts/user.ts:20` query, chosen from its name
- [ ] `packages/shared/src/contracts/user.ts:22` mutation, chosen from its name; output: todoSchema of the 4.x response type
- [ ] `packages/shared/src/contracts/user.ts:24` query, chosen from its name; output: todoSchema of the 4.x response type

## Access

The forms admit exactly the callers 4.x admitted, and `jsonAcl("acl")` the rows 4.x's `hasEntryACL` did, but for a user listed twice in a row's list (marked). "Read" without a row id was open to every signed-in user; decide whether that was meant. A method whose input has `id` under a form that checks no row ("public", say) carries `rowless: true` (marked): 5.0 refuses to define that shape on a service with an access policy without it, and it keeps the 4.x callers.

- [ ] `apps/api/src/services/label.ts:66` 4.x had no row-level access here (no hasEntryACL, no checkAccess): only service grants opened rows, which this empty policy keeps. Give it a real policy if rows belong to someone
- [ ] `apps/api/src/services/label.ts:77` 4.x's resolveEntryId was a function, kept here: where it returns nothing, the "" makes the row check fail, so only the service grant passes (4.x then applied the plain level)
- [ ] `apps/api/src/services/label.ts:88` "Read" with no row id let every signed-in user call this in 4.x, and "authenticated" keeps that; narrow it ({ service: "Read" }, { entry: "Read", id } or a scope form) if that was not meant
- [ ] `apps/api/src/services/project.ts:94` 4.x's hasEntryACL read the row's `acl` column ([{ userId, level }]), and so does jsonAcl("acl"), with one difference: a user with several entries in a row's list gets the highest of their levels, where 4.x took the first. Check the stored lists for duplicate entries
- [ ] `apps/api/src/services/project.ts:99` "Read" with no row id let every signed-in user call this in 4.x, and "authenticated" keeps that; narrow it ({ service: "Read" }, { entry: "Read", id } or a scope form) if that was not meant
- [ ] `apps/api/src/services/project.ts:130` "Read" with no row id let every signed-in user call this in 4.x, and "authenticated" keeps that; narrow it ({ service: "Read" }, { entry: "Read", id } or a scope form) if that was not meant
- [ ] `apps/api/src/services/task/methods/create-task.ts:9` "Read" with no row id let every signed-in user call this in 4.x, and "authenticated" keeps that; narrow it ({ service: "Read" }, { entry: "Read", id } or a scope form) if that was not meant
- [ ] `apps/api/src/services/task/methods/queries.ts:6` "Read" with no row id let every signed-in user call this in 4.x, and "authenticated" keeps that; narrow it ({ service: "Read" }, { entry: "Read", id } or a scope form) if that was not meant
- [ ] `apps/api/src/services/user.ts:40` "Read" with no row id let every signed-in user call this in 4.x, and "authenticated" keeps that; narrow it ({ service: "Read" }, { entry: "Read", id } or a scope form) if that was not meant
- [ ] `apps/api/src/services/user.ts:75` this method takes an id but its access "public" checks no row, which 4.x allowed and 5.0 refuses unless the method says rowless: true, written here: every caller the form admits reaches any row by its id. Narrow it ({ entry: "Read" }, or { service: L, entry: L }) unless that is meant

## Access overrides to turn into a policy

4.x decided row access in overridden methods; 5.0 decides it in the service's `access` policy, for every surface at once.

- [ ] `apps/api/src/services/task/index.ts:11` 4.x decided row access in checkEntryACL (now functions in this file): port them to a policy (owner, jsonAcl, members, inherit, everyone, anyOf or resolver). Until then this policy grants no row, so only service grants pass
- [ ] `apps/api/src/services/task/service-core.ts:22` 4.x access override: port it to the service's access policy (owner, jsonAcl, members, inherit, everyone, anyOf or resolver), then delete this function
- [ ] `apps/api/src/services/user.ts:20` 4.x access override: port it to the service's access policy (owner, jsonAcl, members, inherit, everyone, anyOf or resolver), then delete this function
- [ ] `apps/api/src/services/user.ts:36` 4.x decided row access in checkAccess (now functions in this file): port them to a policy (owner, jsonAcl, members, inherit, everyone, anyOf or resolver). Until then this policy grants no row, so only service grants pass

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
- [ ] `apps/api/src/services/project.ts:148` room event: declare it in the contract's events and send it with ctx.rooms.emit(room, contract, event, payload)
- [ ] `apps/api/src/services/project.ts:164` hand emit: 5.0 sends collection deltas from tracked writes; write through db and let the tracked write emit, then delete this hand emit once the collection is declared in the contract
- [ ] `apps/api/src/services/task/methods/create-task.ts:19` hand emit: 5.0 sends collection deltas from tracked writes; write through db and let the tracked write emit, then delete this hand emit once the collection is declared in the contract
- [ ] `apps/api/src/services/task/methods/queries.ts:29` hand emit: send a reset with qd.collections.reset(contract, collection, scope), if one is still needed
- [ ] `apps/api/src/services/task/methods/update-task.ts:13` hand emit: 5.0 sends entity frames from tracked writes; delete this once the write goes through db
- [ ] `apps/api/src/services/task/methods/update-task.ts:26` hand emit: 5.0 sends entity frames from tracked writes; delete this once the write goes through db
- [ ] `apps/api/src/services/task/methods/update-task.ts:28` hand emit: 5.0 sends collection deltas from tracked writes; write through db and let the tracked write emit, then delete this hand emit once the collection is declared in the contract
- [ ] `apps/api/src/services/user.ts:63` hand emit: 5.0 sends entity frames from tracked writes; delete this once the write goes through db

## this.create, this.update and this.delete to write through db

The 4.x CRUD helpers also emitted and ran lifecycle hooks; `db.<model>` writes are tracked and throw on failure.

- [ ] `apps/api/src/services/project.ts:102` 4.x CRUD helper this.create: it also emitted the entity and collection deltas and ran the lifecycle hooks. Write db.project.create(...) instead (frames follow the tracked write; hooks do not run; db.create throws on failure)
- [ ] `apps/api/src/services/project.ts:124` 4.x CRUD helper this.update: it also emitted the entity and collection deltas and ran the lifecycle hooks. Write db.project.update(...) instead (frames follow the tracked write; hooks do not run; 4.x returned null for a missing row where db.update throws NOT_FOUND)
- [ ] `apps/api/src/services/project.ts:146` 4.x CRUD helper this.update: it also emitted the entity and collection deltas and ran the lifecycle hooks. Write db.project.update(...) instead (frames follow the tracked write; hooks do not run; 4.x returned null for a missing row where db.update throws NOT_FOUND)
- [ ] `apps/api/src/services/project.ts:159` 4.x CRUD helper this.delete: it also emitted the entity and collection deltas and ran the lifecycle hooks. Write db.project.delete(...) instead (frames follow the tracked write; hooks do not run; 4.x returned false for a missing row where db.delete throws NOT_FOUND)

## Raw SQL writes to record with ctx.touch

Tracked writes cannot see raw SQL; `ctx.touch(model, ids)` records the rows it changed (lint: `no-raw-sql-write`).

- [ ] `apps/api/src/services/task/methods/queries.ts:26` raw SQL write: tracked writes cannot see it, so subscribers would miss it; record the rows with ctx.touch(model, ids), or reset a scope with qd.collections.reset (lint: no-raw-sql-write)

## Lifecycle hooks

Hooks ran only inside the CRUD helpers; move their work into the methods that write.

- [ ] `apps/api/src/services/project.ts:67` 4.x lifecycle hook, run only by this.create: move what it does into the methods that create rows (or affects, for rows of other services), then delete it

## installAdminMethods to replace with the admin kit

`admin.contract({ entity })` and `admin.handlers(contract, options)`.

- [ ] `apps/api/src/services/project.ts:29` installAdminMethods: use the admin kit (...admin.contract({ entity }) in the contract, ...admin.handlers(contract, { displayName, hiddenFields, fieldOverrides }) in methods), then delete this; it is no longer used

## Methods a kit implements

Methods of a kit method's shape (`get`, `list`, `create`, `getTask`, ...): the kit checks access on every row it touches, pages and stays live (lint: `prefer-kit`). Replace each with its kit, or keep it with a `// quickdraw: hand-written because <reason>` comment above it.

- [ ] `apps/api/src/services/label.ts:69` getLabel has the shape of the read/write kit's get, which checks access on every row it touches, pages and stays live: replace it with crud.handlers (crud.contract in the contract), or keep it with a "// quickdraw: hand-written because <reason>" comment above it (lint: prefer-kit)
- [ ] `apps/api/src/services/label.ts:86` listLabels has the shape of the read/write kit's list, which checks access on every row it touches, pages and stays live: replace it with crud.handlers (crud.contract in the contract), or keep it with a "// quickdraw: hand-written because <reason>" comment above it (lint: prefer-kit)
- [ ] `apps/api/src/services/project.ts:97` createProject has the shape of the read/write kit's create, which checks access on every row it touches, pages and stays live: replace it with crud.handlers (crud.contract in the contract), or keep it with a "// quickdraw: hand-written because <reason>" comment above it (lint: prefer-kit)
- [ ] `apps/api/src/services/project.ts:111` getProject has the shape of the read/write kit's get, which checks access on every row it touches, pages and stays live: replace it with crud.handlers (crud.contract in the contract), or keep it with a "// quickdraw: hand-written because <reason>" comment above it (lint: prefer-kit)
- [ ] `apps/api/src/services/project.ts:155` deleteProject has the shape of the read/write kit's delete, which checks access on every row it touches, pages and stays live: replace it with crud.handlers (crud.contract in the contract), or keep it with a "// quickdraw: hand-written because <reason>" comment above it (lint: prefer-kit)
- [ ] `apps/api/src/services/task/index.ts:14` createTask has the shape of the read/write kit's create, which checks access on every row it touches, pages and stays live: replace it with crud.handlers (crud.contract in the contract), or keep it with a "// quickdraw: hand-written because <reason>" comment above it (lint: prefer-kit)
- [ ] `apps/api/src/services/task/index.ts:16` listTasks has the shape of the read/write kit's list, which checks access on every row it touches, pages and stays live: replace it with crud.handlers (crud.contract in the contract), or keep it with a "// quickdraw: hand-written because <reason>" comment above it (lint: prefer-kit)
- [ ] `apps/api/src/services/task/index.ts:19` updateTask has the shape of the read/write kit's update, which checks access on every row it touches, pages and stays live: replace it with crud.handlers (crud.contract in the contract), or keep it with a "// quickdraw: hand-written because <reason>" comment above it (lint: prefer-kit)
- [ ] `apps/api/src/services/user.ts:48` updateUser has the shape of the read/write kit's update, which checks access on every row it touches, pages and stays live: replace it with crud.handlers (crud.contract in the contract), or keep it with a "// quickdraw: hand-written because <reason>" comment above it (lint: prefer-kit)

## Service instance state and the 4.x context

A service is an object now: no constructor, no fields, no `this`; handlers read `ctx.principal`.

- [ ] `apps/api/src/services/label.ts:11` 4.x instance field renamed of LabelService: now module state, one value for the whole process (a service object has no instance); keep it if that is right, else move it where it belongs
- [ ] `apps/api/src/services/label.ts:15` 4.x instance field onChange of LabelService, set by its constructor: now a module binding setUpLabelService(...) sets, one value for the whole process (a service object has no instance); keep it if that is right, else move it where it belongs
- [ ] `apps/api/src/services/label.ts:19` 4.x instance field room of LabelService, set by its constructor: now a module binding setUpLabelService(...) sets, one value for the whole process (a service object has no instance); keep it if that is right, else move it where it belongs
- [ ] `apps/api/src/services/label.ts:22` 4.x constructor code of LabelService, its fields' values included: a service object has no constructor; call setUpLabelService(...) once where the server starts (or move each part to module scope or a job), then delete this function
- [ ] `apps/api/src/services/label.ts:25` this.getRoomName was 4.x service-instance state: a service object has none. Import what it held, pass it in, or call another service with ctx.services
- [ ] `apps/api/src/services/label.ts:36` this.constructor was 4.x service-instance state: a service object has none. Import what it held, pass it in, or call another service with ctx.services
- [ ] `apps/api/src/services/label.ts:43` this.subscribers was 4.x service-instance state: a service object has none. Import what it held, pass it in, or call another service with ctx.services
- [ ] `apps/api/src/services/label.ts:48` overrode the 4.x BaseService method unsubscribeSocket, which 5.0 does not have: keep what it still needs elsewhere, then delete it
- [ ] `apps/api/src/services/label.ts:50` dropped super.unsubscribeSocket(socket), a call of the 4.x base class, which 5.0 does not have: do here what this code still needs of it
- [ ] `apps/api/src/services/label.ts:55` overrode the 4.x BaseService method adminCreate, which 5.0 does not have: keep what it still needs elsewhere, then delete it
- [ ] `apps/api/src/services/label.ts:57` super.adminCreate(data) called the 4.x base class, which 5.0 does not have: it is undefined here; do what this code still needs of it
- [ ] `apps/api/src/services/task/methods/queries.ts:9` inline auth guard: the access form already requires a principal, so the !ctx.principal.userId part never holds; drop it (lint: no-inline-auth-guard)

## Errors the caller no longer sees

4.x sent a thrown error's message to the caller; 5.0 answers any error that is not a `QuickdrawError` with `INTERNAL` and a generic message (the original is logged). Throw `new QuickdrawError(code, message)` with the code that fits (`NOT_FOUND`, `FORBIDDEN`, `CONFLICT`, `VALIDATION`, ...) wherever the caller should see the message.

- [ ] `apps/api/src/services/project.ts:161` 4.x sent this error's message to the caller; 5.0 answers an error that is not a QuickdrawError with INTERNAL and a generic message: throw new QuickdrawError(code, message) with the code that fits (NOT_FOUND, FORBIDDEN, CONFLICT, VALIDATION) if the caller should see it
- [ ] `apps/api/src/services/project.ts:193` 4.x sent this error's message to the caller; 5.0 answers an error that is not a QuickdrawError with INTERNAL and a generic message: throw new QuickdrawError(code, message) with the code that fits (NOT_FOUND, FORBIDDEN, CONFLICT, VALIDATION) if the caller should see it
- [ ] `apps/api/src/services/task/methods/create-task.ts:13` 4.x sent this error's message to the caller; 5.0 answers an error that is not a QuickdrawError with INTERNAL and a generic message: throw new QuickdrawError(code, message) with the code that fits (NOT_FOUND, FORBIDDEN, CONFLICT, VALIDATION) if the caller should see it
- [ ] `apps/api/src/services/task/methods/queries.ts:11` 4.x sent this error's message to the caller; 5.0 answers an error that is not a QuickdrawError with INTERNAL and a generic message: throw new QuickdrawError(code, message) with the code that fits (NOT_FOUND, FORBIDDEN, CONFLICT, VALIDATION) if the caller should see it
- [ ] `apps/api/src/services/user.ts:54` 4.x sent this error's message to the caller; 5.0 answers an error that is not a QuickdrawError with INTERNAL and a generic message: throw new QuickdrawError(code, message) with the code that fits (NOT_FOUND, FORBIDDEN, CONFLICT, VALIDATION) if the caller should see it

## Client

Hook calls now go through the typed client (`qd.<service>.<member>`); these need a decision.

- [ ] `apps/web/src/components/AdminCount.tsx:8` this 4.x hook call was not converted: it names the service or method at run time. Call the typed client's member (qd.<service>.<method>) instead
- [ ] `apps/web/src/components/Members.tsx:7` invalidateOn is gone: give the query a watch in its contract entry (it is fetched again when that collection scope changes), or read a collection
- [ ] `apps/web/src/components/Members.tsx:13` room events: declare them in the contract's events and listen with qd.<service>.<event>.useEvent(handler)
- [ ] `apps/web/src/components/ProjectList.tsx:14` onError receives a QuickdrawError now (4.x passed the message string): read error.message or error.code
- [ ] `apps/web/src/components/TaskBoard.tsx:7` declare the collection "byProject" in the taskService contract (see the [collection] marker where 4.x defined it): qd.taskService.byProject does not exist until then, and the cast to the 4.x item type stands in for its type; delete the cast once it is declared
- [ ] `apps/web/src/components/TaskBoard.tsx:8` compare is gone: items follow the contract collection's order (put the sort there)
- [ ] `apps/web/src/components/TaskBoard.tsx:16` manual refetch: live data, watch and the invalidation coordinator keep quickdraw queries current; delete it, or give the query a watch
- [ ] `apps/web/src/components/TaskDetail.tsx:9` error is a QuickdrawError now (4.x: the message string): read error.message, or error.code (FORBIDDEN, NOT_FOUND, ...) to tell failures apart
- [ ] `apps/web/src/hooks/useMyProjects.ts:16` declare the collection "mine" in the projectService contract (see the [collection] marker where 4.x defined it): qd.projectService.mine does not exist until then, and the cast to the 4.x item type stands in for its type; delete the cast once it is declared
- [ ] `apps/web/src/hooks/useMyProjects.ts:17` compare is gone: items follow the contract collection's order (put the sort there)
- [ ] `apps/web/src/providers.tsx:7` 4.x QuickdrawProvider props (serverUrl, authToken, autoConnect): 5.0 takes client={qd} (lib/quickdraw), url, auth and socketOptions

## Server wiring and other 4.x APIs

What lint's `no-v4-api` also reports, each with its replacement: the server set-up, room helpers, removed types.

- [ ] `apps/api/src/index.ts:4` 4.x API ServiceRegistry (removed): lint's no-v4-api names each replacement
- [ ] `apps/api/src/index.ts:17` the 4.x service was constructed here (new ProjectService(...)): it is the object projectService now; pass it in qd.createServer({ services: [...] })
- [ ] `apps/api/src/index.ts:19` the 4.x service was constructed here (new TaskService(...)): it is the object taskService now; pass it in qd.createServer({ services: [...] })
- [ ] `apps/api/src/index.ts:21` the 4.x service was constructed here (new UserService(...)): it is the object userService now; pass it in qd.createServer({ services: [...] })
- [ ] `apps/api/src/index.ts:23` the 4.x service was constructed here (new LabelService(...)): it is the object labelService now; pass it in qd.createServer({ services: [...] })
- [ ] `apps/api/src/index.ts:25` the 4.x service was constructed here (new HealthService(...)): it is the object healthService now; pass it in qd.createServer({ services: [...] })
- [ ] `apps/api/src/services/build-services.ts:6` the 4.x service was constructed here (new ProjectService(...)): it is the object projectServiceDef now; pass it in qd.createServer({ services: [...] })
- [ ] `apps/api/src/services/build-services.ts:10` the 4.x service was constructed here (new LabelService(...)): it is the object labelService now; pass it in qd.createServer({ services: [...] })
- [ ] `apps/api/src/services/build-services.ts:17` projectService is a 4.x ProjectService instance, whose members (getRoomName here) the service object projectService does not have: call a contract method through qd.caller(principal).projectService.<method>(input), and move other logic into a module of its own
- [ ] `apps/api/src/services/label.ts:2` 4.x API QuickdrawSocket (moved): lint's no-v4-api names each replacement
- [ ] `apps/api/src/services/project.ts:8` 4.x API CollectionSnapshotPage (removed): lint's no-v4-api names each replacement
- [ ] `apps/api/src/services/reload.ts:5` LabelService is imported dynamically here, and 5.0 has no class: import the service object labelService (pass it in qd.createServer({ services: [...] })), or call it through qd.caller(principal)
- [ ] `apps/api/src/services/reload.ts:7` the 4.x service was constructed here (new LabelService(...)): it is the object labelService now
- [ ] `apps/api/src/services/reload.ts:9` labels is a 4.x LabelService instance, whose members (getRoomName here) the service object labelService does not have: call a contract method through qd.caller(principal).labelService.<method>(input), and move other logic into a module of its own
- [ ] `apps/api/src/services/shared/guards.ts:1` 4.x API ServiceMethodContext (removed): lint's no-v4-api names each replacement
- [ ] `apps/api/src/services/task/service-core.ts:3` 4.x API CollectionSnapshotPage (removed): lint's no-v4-api names each replacement
- [ ] `apps/api/src/services/user.ts:4` 4.x API QuickdrawSocket (moved): lint's no-v4-api names each replacement
- [ ] `apps/web/src/components/AdminCount.tsx:3` 4.x API useServiceQuery (removed): lint's no-v4-api names each replacement
- [ ] `apps/web/src/hooks/index.ts:3` 4.x API useRoomEvents (removed): lint's no-v4-api names each replacement
- [ ] `apps/web/src/hooks/useMyProjects.ts:3` 4.x API useQuickdrawSocket (removed): lint's no-v4-api names each replacement
- [ ] `packages/shared/src/events.ts:4` QuickdrawEventMap typed 4.x room events: declare each event in its contract (events: { name: { payload } }), send it with ctx.rooms.emit and listen with qd.<service>.<event>.useEvent, then delete this augmentation
- [ ] `packages/shared/src/index.ts:4` 4.x API serviceRoom (removed): lint's no-v4-api names each replacement

## Carve-outs

New files written from code inside a template carve-out (the lines between its `<name>:start` and `<name>:end` comments): a fork that strips the carve-out must delete them too, so list each wherever the carve-out's own files are listed. The lines they add to shared files sit between the carve-out's comments.

- [ ] `packages/shared/src/contracts/label.ts:5` this file belongs to the quickdraw-labels carve-out (it was written from code between its markers): list it wherever the carve-out's own files are (a fork script's delete list), then delete this line
