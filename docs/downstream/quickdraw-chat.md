# quickdraw-chat: done, the worked example

Migrated. The template the other apps were copied from moved from 4.1 to
5.0 on the release candidates and was the release gate: 5.0.0 shipped only
after it ran on one, and everything awkward it found was fixed in quickdraw
first (findings F1 to F10, round by round in RFC 0003 section 17 and the
changelog's release-candidate sections). On 2026-10-05 its `dev` runs
`5.0.0-rc.5`, deployed as the hosted dev instance, with `5.0.0-rc.6` in
progress.

## The pull requests (fitzzero/quickdraw-chat)

| PR  | What                                                                                                                        |
| --- | --------------------------------------------------------------------------------------------------------------------------- |
| #46 | packages, the codemod's output, contracts and lint on `5.0.0-rc.1`                                                          |
| #47 | the server: access policies, tracked writes, collections, `createServer`, the auth routes kit, MCP                          |
| #48 | the web app on the typed client, admin kit screens, Storybook on the mock client, `renderWithQuickdraw` tests               |
| #49 | the game on the realtime kit, the Godot client on protocol 5, a headless two-client check                                   |
| #50 | polish: rules and docs for 5.0, the `quickdraw-docs` reference, budgets, carve-outs, the manual run                         |
| #51 | `5.0.0-rc.4`, every workaround replaced by the framework's primitive                                                        |
| #52 | the migration into `dev`, with its review's fixes (verified emails, the chat roles, `updateUser`'s output) and `5.0.0-rc.5` |
| #53 | hosted dev sign-in: only the providers the API serves, `API_URL` off localhost, the proxy trusted                           |

Its `CHANGELOG.md` ("quickdraw 5.0") lists every access change a fork
inherits, and `DEPLOYMENT.md` ("Upgrading to quickdraw 5.0") what an
operator does once.

## What it taught the other apps

- **Size, from the final codemod** on `0227ee0`: 4 files deleted (the
  wrapper hooks and their types), 264 report items in 61 files, every output
  file parsing, and lint clean on it with a baseline.
- **Order.** Zod 4 in the shared package and the api before the contracts
  get real schemas; the codemod's output committed as it is, lint adopted
  with a baseline at once; then contracts, access with an access matrix
  per service, the server, the web app, the game.
- **Access.** Chat membership is a `members` policy, and `myChats` a `via`
  collection on `chatMember` with maintained `Chat.memberCount` and
  `Chat.lastMessageAt` columns (an `order` names columns only); documents
  are `jsonAcl` with the sharing kit; public profiles use
  `everyone("Read")`. Every narrowing or widening is named in its pull
  request.
- **Auth.** The auth routes kit over a `Session` table (everyone signs in
  once more); an email counts only once a provider verified it, so
  `ADMIN_EMAILS` admins sign in once through one that does; REST routes
  take `requireSession`, `sessionOf` and `qd.caller(principal)`.
- **Writes.** It reads first only where it must know what a write did (a
  new member, a new best score); everything else goes through `db`.
- **The game.** Its input channel requires the world's room, its snapshot
  stream is volatile with a seed computed per subscriber, its rooms are
  joined with `useJoin` and left in its own `onRoomLeave`, and its Godot
  client is quickdraw's `examples/godot` client.
- **Tests.** An access matrix per service, live-delta tests over real
  sockets, component tests against a real server, and budgets for the chat
  list, a message send, a document share and the game's join.

## What remains

- `5.0.0-rc.6` (in progress), then `5.0.0` after the release: a card on the
  quickdraw-chat project, which also replaces the app's own
  `GET /auth/providers` route with the kit's.
