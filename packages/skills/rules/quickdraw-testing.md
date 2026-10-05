---
paths:
  - "apps/**/*.test.ts"
  - "apps/**/*.test.tsx"
  - "apps/**/__tests__/**"
  - "apps/**/__budgets__/**"
---

# quickdraw 5.0: testing

> From `@fitzzero/quickdraw-skills` (`quickdraw-skills link`). `paths` follow
> the quickdraw template: integration tests in `apps/*/src/__tests__/`, unit
> tests beside the code. Another layout replaces this link with a copy and
> edits them; when the app's own rules name other paths, theirs win.

Test through the real server: the same dispatcher, access engine, tracked
writes and frames production runs. Helpers come from
`@fitzzero/quickdraw-core/testing`, `@fitzzero/quickdraw-core/testing/client`
and `@fitzzero/quickdraw-core/testing/prisma`.

## Where a test goes

The template runs two lanes, and a file's name picks its lane:

| Test                                                                            | File (template)                                      | Lane                                                  |
| ------------------------------------------------------------------------------- | ---------------------------------------------------- | ----------------------------------------------------- |
| a service: `createTestApp`, `describeAccessMatrix`, `expectBudget`, live frames | `apps/api/src/__tests__/services/<name>.int.test.ts` | integration (`vitest.int.config.ts`): a test database |
| a component against the real server (`renderWithQuickdraw`)                     | `apps/web/src/__tests__/<name>.int.test.tsx`         | the web app's integration lane, under jsdom           |
| pure logic: a helper, a reducer, a game's simulation step                       | beside it, `<file>.test.ts`                          | unit (`vitest.config.ts`): no database                |

A test that boots the app but is named `<name>.test.ts` runs in the unit
lane and fails at its first query. Budgets go to `__budgets__/` beside the
test file that measures them.

## The test app

```ts
const app = await createTestApp({ services: [projectService, taskService], db });
const task = await app.as(ada).taskService.create({ projectId, title: "Write the docs" });
const { call, close } = await app.connect(bo); // a real protocol 5 socket
await call.taskService.get({ id: task.id });
await app.frames.waitFor({ event: "qd:e", userId: bo.userId });
await app.close();
```

- `createTestApp` takes `createServer`'s options plus `strictWarnings`. A
  socket acts as the principal it connects as, the rate limiter is off, and
  the server listens on a free port of 127.0.0.1 (`app.url`).
- `app.as(principal)` calls in process; `app.connect(principal)` resolves
  `{ call, socket, hello, close }` once the server said hello. Pass `null`
  for an anonymous caller. Both callers are keyed by service name
  (`taskService`), where the web client uses the contract map's keys.
- `app.frames(match?)` lists every frame the server sent, each with its
  `event`, `data`, `socketId`, `userId` and `at`;
  `frames.waitFor(match, timeoutMs?)` waits for one, `frames.clear()`
  forgets them. Assert on frames, not internals. For realtime frames use
  the typed matchers, never a cast of `data`:
  `waitFor({ ...streamFrames(game, "world", (snap) => snap.tick === tick), socketId })`,
  `eventFrames(game, "death", (death) => death.id === id)`, or an event
  query's `where` (`{ event: "qd:presence", where: ({ data }) => ... }`).
- The app's dispatcher becomes current for the services' `qd`, so
  `qd.run`, `qd.stream(...).push` and `qd.presence` reach it.
- `db` is the tracked client over a test database, made exactly as in
  production (`trackPrisma(new PrismaClient({ adapter }))`). The
  `./testing/prisma` helpers give each worker a database:
  `createPrismaTestGlobalSetup`, `workerDatabaseUrl` and `resetDatabase`
  (PostgreSQL, or PGlite when no `TEST_DATABASE_URL` is set; each worker
  boots its PGlite with `openPgliteFromTemplate`, which works under jsdom).
- Seed rows with the untracked client (`prisma`), or inside `qd.run` (before
  the app starts too, when its writes reach no one): a tracked write outside
  any unit of work flushes on its own with an `ambient-write` warning.
- An app's own REST route is tested over HTTP against the app's Express app,
  signed in as the auth routes sign in: its call runs with the grants a
  socket of the same user gets (`qd.caller` loads them), so a method behind
  a service grant passes or answers 403 as it does over a socket.

## Every service gets an access matrix

```ts
await describeAccessMatrix(app, {
  service: taskService,
  principals: { owner: ada, member: bo, stranger: ed },
  cases: [
    { method: "get", input: { id }, allow: ["owner", "member"] },
    { method: "remove", input: { id }, expect: { owner: "allow", member: "FORBIDDEN" } },
  ],
});
```

- Each case runs as each principal and anonymously (`"deny"` means
  `UNAUTHENTICATED` without a principal, `FORBIDDEN` with one). It rejects
  listing every cell that differs; `via: "socket"` runs it over sockets.
- Mutations run for real, once per allowed principal: give inputs that can
  run again, or `input` as a function of the cell
  (`input: async () => ({ id: await newTask() })`), which makes a fresh row
  for every cell; never order the principals so the allowed one goes last.

## Hot methods get a budget

```ts
await expectBudget(() => app.as(ada).taskService.list({ limit: 20 }), { name: "list a page" });
```

- It records SQL statements and bytes (never time) per call and for the
  whole step, in `__budgets__/<test file>.json` beside the test: commit it.
  A missing entry is written, a cheaper step rewrites its entry (under CI it
  fails: rerun locally and commit), a costlier one fails naming each number
  that grew. Statements must match exactly; bytes may move 5%.
- Accept a deliberate rise with `QD_ALLOW_BUDGET_GROWTH=1` (every budget) or
  `QD_ALLOW_BUDGET_GROWTH="list a page"` (the ones named), then commit the
  file. Give each step of a test file its own name. Await everything the
  step should cost inside `run`, measure one step at a time, and run a step
  once first when it may pay a one-time read.

## Development warnings

`createTestApp({ strictWarnings: true })` (under vitest or jest) throws each
development warning raised in that app's method calls (`n-plus-one`,
`unbounded-read`, `oversized-response`, `nested-write`, `batch-read`,
`batch-create-many`) as a `DevWarningError` where it happens, failing the
test that caused it (an oversized reply fails an in-process `app.as(...)`
call; over a socket or HTTP the reply was already sent, so it is logged, not
thrown). Warnings outside its calls (an `ambient-write` while seeding) are
logged, and `app.close()` ends it. `tiered-field-in-output` (a method's own
output schema declares a tiered field, at any depth) is thrown by
`createTestApp` itself: answer `"entity"` from that method rather than
turning strictness off.
Turn it on for service suites.
`createRecordingSink()` passed as `flushSink` records what each flush wrote.

## Components

- Against the real server:
  `const view = await renderWithQuickdraw(<Board projectId={id} />, { app, as: ada, client: qd })`
  from `./testing/client` returns Testing Library's result plus
  `connection`, `queryClient`, `disconnect()` and `reconnect()`. Change
  data with `app.as(...)` and wait for the screen (`findByText`). Run these
  in a jsdom project of their own, with the API's global setup (its test
  database template) and a setup file calling `installJsdomShims()` from
  `./testing/client` (element scrolling, `Blob.arrayBuffer`); they import
  the API's services across apps.
- Without a server: `createMockClient({ task, project })` has the typed
  client's shape with stubs: `qd.task.get.mockResolvedValue(row)`,
  `mockRejectedValue(error)`, `mockImplementation(fn)`, `calls`;
  `qd.task.useEntity.mockRow(row)` (and `mockRemoved`, `mockError`);
  `qd.task.board.mockScope(scope, items)`; `mockItems` for a stream, `sent`
  for a channel, `mockEmit` for an event. Everything set is forgotten
  after each test only when the runner has a global `afterEach` (vitest
  with `globals: true`, or jest); otherwise add
  `afterEach(() => mock.$reset())`. It shows no optimistic updates.
- A component that reads the connection (`useQuickdraw()`,
  `usePresence(room)`) renders inside the mock's provider:
  `render(<UserMenu />, { wrapper: mock.$Provider })`, with
  `mock.$session({ userId, serviceAccess, isConnected, isKnown })` (fields
  left out keep the starting session, `createMockClient(contracts, { session })`)
  and `mock.$presence(room, userIds)`. Never re-export `useQuickdraw` from
  the module you mock to fake it. `useAdminServices(mock)` asks only the
  services the session's `serviceAccess` allows.
- Storybook and other browser bundles import the mock from
  `@fitzzero/quickdraw-core/testing/mock`, which names no Testing Library:
  a decorator wraps every story in `qd.$Provider`, and a story's
  `beforeEach` sets its session beside its data. Stories rendered side by
  side (a docs page) each pass their own:
  `<qd.$Provider session={{ userId: null }}>`, laid over the mock's for
  that subtree alone.

## What a new service's tests cover

1. The access matrix of every method.
2. Live behavior: a write by one user reaches another's entity or
   collection (`frames.waitFor`, or a rendered component).
3. A budget for each method a page calls on load, or in a loop.
4. Errors callers rely on (`NOT_FOUND`, `CONFLICT`, `VALIDATION`) by code.
