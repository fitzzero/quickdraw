# x-tokage-siege: upgrade brief

On 4.1.0, with lobbies, boards, live collections and a channel; the first
app to run the codemod after quickdraw-chat, whose game is the closest
worked example for its lobbies.

## Size

9 services, 58 methods, 7 collections and 1 channel (the audit of
2026-10-02). Run the codemod's dry run for the report's counts before
planning.

## Top hazards

1. **Its own MCP stdio loop.** It moves onto the bridge in
   `@fitzzero/quickdraw-core/server/mcp`: `createMcpRegistry` generates
   tools from the contracts' methods and takes the app's own as
   `customTools` (`authenticated` by default), and `createMcpStdioServer`
   serves them. Tool names default to `{service}_{method}`, a failure is a
   tool result with `isError` rather than a JSON-RPC error, and every
   method the bridge exposes needs an input schema with JSON Schema (Zod
   4.2 or later), or registration fails naming it.
2. **Hand-rolled optimistic state.** 5.0 makes a mutation optimistic by
   default when its input has `id` and its output is `"entity"`, and adds
   rows with `cache.addItem` (`useCollection().pending`; a refusal kept
   with `onRefused: "keep"`; an unknown outcome `checking`). Delete the
   hand-rolled layer for those (or the change is applied twice), and set
   `optimistic: false` where the app must wait for the server.
3. **Seven collections, and boards.** Each becomes a contract collection:
   a scope column (or `via` for a junction table, with `refreshEntry: true`
   for a count read from it), `order` columns ending in `id`, and the
   anchor whose policy decides who may open a scope. Port a board to a
   collection with `index` and `views`, not to one fat watched query
   (`MIGRATION.md`, "Boards").
4. **Lobbies.** Joins are methods (`ctx.rooms.join`, events declared in the
   contract, `usePresence` for who is there): at most 100 app rooms per
   socket, `qd:` and `user:` names refused, no joins inside a `share`d
   query. A room is lost on every reconnect, so the client re-joins with
   `useJoin`; `onRoomLeave` (on the lobby's service) sees a player leave,
   with `last` once no socket of theirs is left, and `qd.rooms` reaches a
   lobby from a timer or a job (`rooms.leave(room, { userId })` to kick).
5. **Its channel.** 5.0 drops anonymous senders, and 4.x's `requireRoom`
   becomes `requires: { room }`: a fixed name, a function of the payload,
   or `{ prefix: "lobby:" }` for any lobby the socket joined, which the
   handler reads as `ctx.room` instead of a lobby id in every frame. The
   sending socket must have joined that room through a method it called
   itself.

## Suggested order

1. Codemod and lint with a baseline; contracts with real schemas; access.
2. The collections and boards, with emits deleted once each is declared.
3. The client: typed hooks, then the optimistic layer removed screen by
   screen.
4. Lobbies on rooms with `useJoin` and `onRoomLeave`, then the channel.
5. The MCP loop onto the bridge, last: it reads the finished contracts.
6. Budgets for a board's first load and a write with many viewers.
