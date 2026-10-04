# quickdraw-chat: upgrade brief

On 4.1.0. The template the other apps were copied from, and the reference
migration: 5.0.0 is released only after quickdraw-chat runs on the release
candidate ([`release-checklist-5.0.md`](../release-checklist-5.0.md)).
**Anything awkward found here is a framework bug, to fix in quickdraw before
the release**, not to work around in the app.

## Size

7 services (chat, definition, document, game, message, push-subscription,
user), 31 methods, 2 collections (`myChats`, `byChat`), 1 channel (the
game's `input`): the audit of 2026-10-02. The codemod's dry run of
2026-10-03, on the checkout at `8769870` (its `apps/` and `packages/` match
quickdraw-chat's `dev`): 7 contracts, 31 schemas moved, 26 `todoSchema`
placeholders, 18 web files rewritten, 3 wrapper hooks deleted; 66 files
changed, 12 created, 3 deleted; 214 report items in 59 files: contracts 38,
access 15, access overrides 10, projections 6, collections 2, emits 9,
writes 7, hooks 2, admin 7, instance state 42, client 23, server and other
4.x APIs 53. Rerun on 2026-10-04 with the review's codemod fixes (no
self-referential `const chatService = chatService`, `packages/db` scanned,
instance members marked by type): 67 files changed, 13 created (the report
among them), 3 deleted; 247 items in 61 files (client 24, server and other
4.x APIs 85: the 31 new ones are uses of 4.x instance members, 20 of them in
`game.int.test.ts`). Typecheck errors with `@project/shared` and
`@project/db` read from source: shared 3, api 238, web 37 (were 3, 233, 44);
the errors no marker covers are 4.x collection deltas read in two
integration tests (`delta.type`, `delta.item`), parameters left unused once
`new X(prisma, options)` became the service object (`build-services.ts`),
two helpers only the 4.x constructors called, implicit `any`s downstream of
removed types, and 5.0's readonly items and `undefined` for a missing
entity in three components.

## Top hazards

1. **Chat access is a membership table.** The `checkEntryACL` override over
   `ChatMember` becomes a `members` policy, and `myChats` (each chat fanned
   out to every member's list) a `via` collection on `chatMember` with
   `scopeAccess: "self"`; its computed `memberCount` and `lastMessageAt`
   become a projection `map`, kept fresh by an `affects` from a message to
   its chat. **Ordering:** a contract `order` names columns only, so the
   sort by `lastMessageAt ?? createdAt` (`useMyChats.ts`) needs a maintained
   `Chat.lastMessageAt` column or stays a client-side sort.
2. **Access overrides and open reads.** Port the overrides in chat,
   document (`jsonAcl("acl", { owner: "ownerId" })`, plus the sharing kit
   for its share and unshare methods), game and user into policies; until
   then the codemod's placeholder grants no row. Decide the 12
   `"authenticated"` forms: 4.x let every signed-in user call them.
3. **The copied bootstrap and auth.** The 323-line `apps/api/src/index.ts`
   becomes `qd.createServer`; the OAuth, mock and guest routes become
   `createAuthRoutes` with a `SessionStore` over the app's `Session` model,
   whose tokens carry `sid`, so everyone signs in once more. The hand-built
   socket rate limiter (100 events a minute keyed by user id, subscriptions
   and channels excluded by name) goes too: `createServer`'s is on by
   default at 600 events per minute per socket and never counts subscription
   events, channels or cancels (`rateLimit: { keyGenerator }` keeps keying
   by user). The Discord Activity sign-in stays an app route on
   `issueSession`, and its `setSessionCookie(res, token)` keeps working: it
   now sets the name the routes give the same request (`__Host-session`
   over HTTPS), which `socketAuth` and the HTTP transport read. A cookie
   shared with subdomains through `COOKIE_DOMAIN` is `session` everywhere,
   with nothing to name; only a `cookie.domain` passed to the routes alone
   needs `cookieName: "session"` on `socketAuth` and `http`.
4. **The Godot client speaks the 4.x wire.** The codemod does not touch
   `apps/game/godot/addons/quickdraw/quickdraw_client.gd`. `legacyWire`
   serves its method calls, not its `input` channel or the world
   broadcasts, so it moves to protocol v5: quickdraw's
   `examples/godot/addons/quickdraw/quickdraw_client.gd` (same path, a v5
   client written from `docs/protocol-v5.md`) replaces it, and
   `game.gd`'s calls move from `{success, data}` to `{ok, d}`. The
   channel's `requireRoom` becomes `requires: { room: <the world's room> }`;
   the world's room is joined by a method the Godot socket calls itself
   (`watchWorld`, say), since a room the page's socket joined does not
   count for the game client's socket.
5. **Zod 3 in the api.** `apps/api` is on `zod ^3.25.76`, and
   `packages/shared`, which now holds the contracts and the 31 schemas the
   codemod moved there, lists no `zod` at all. 5.0 validates Zod 3.25
   schemas, but reads a schema's JSON Schema only from Zod 4.2 or later
   (`MIGRATION.md`, "Before you start"): the MCP server (`mcp-bootstrap.ts`,
   `mcp-server.ts`, whose tools come from the contracts' inputs) and the 7
   admin items (the admin kit's field metadata comes from the entity
   schema) fail when the registry or the service is built, naming the
   method. Give `packages/shared` and `apps/api` `zod ^4.2.0` before the
   contracts get their real schemas. The socket packages need a bump too:
   `socket.io` and `socket.io-client` are `^4.7.4` here, and 5.0's peers
   start at `^4.8.0`.

Also: the two `defineService` typing issues the dry run found are fixed in
the release candidate (an unannotated `id` function no longer widens the
other methods' `ctx.principal`; `MethodOf`, typed for `"authenticated"`,
takes `{ service, entry }`), so either one showing up again is a framework
bug. The admin screens name services at run time (they move to
`qd.<service>.admin.*` and `useAdminServices(qd)`), and production stays on
4.x until this ships, so take 4.1.1 when it is out.

## Suggested order

1. Codemod, committed as it is; contracts (the 26 placeholders, the
   `ChatListItem` projection, the user's protected fields as `fields`).
2. Access: the four policies, then the 12 `"authenticated"` decisions.
3. Emits: writes through `db`, both collections declared, the 9 hand emits
   deleted, the `lastMessageAt` decision.
4. Server and auth, then the web client and the tests (`./testing`).
5. The game last, Godot client included, or carved out: the owner's call,
   since the release gate's manual run does not cover it.
6. Lint presets, `quickdraw-skills link`, budgets (the chat list, a message
   send with subscribers), then the release checklist's manual run.
