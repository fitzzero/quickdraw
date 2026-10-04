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
4.x APIs 53.

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
   `issueSession`. Over HTTPS `socketAuth` and the HTTP transport read only
   `__Host-session`, which the routes set when the cookie has no domain;
   if the deployment shares the cookie with subdomains (`COOKIE_DOMAIN`),
   the routes set `session` instead, and both need `cookieName: "session"`.
4. **The Godot client speaks the 4.x wire.** The codemod does not touch
   `apps/game/godot/addons/quickdraw/quickdraw_client.gd`. `legacyWire`
   serves its method calls, not its `input` channel or the world
   broadcasts, so it needs a port to protocol v5; and the channel's
   `requireRoom` (an app room) has no 5.0 form, since `requires` names an
   entity or a collection subscription.

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
