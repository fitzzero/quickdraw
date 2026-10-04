# x-tokage-siege: upgrade brief

On 4.1.0, with lobbies, boards, live collections and a channel; third in
line, after quickdraw-chat and seneschal.

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
   default when its input has `id` and its output is `"entity"`, overlaying
   the cached row and its collection items. Delete the hand-rolled layer
   for those (or the change is applied twice), set `optimistic: false`
   where the app must wait for the server, and use
   `optimistic: (input, cache) => ...` for the rest.
3. **Seven collections, and boards.** Each becomes a contract collection:
   a scope column (or `via` for a junction table), `order` columns ending in
   `id`, and the anchor whose policy decides who may open a scope. Port a
   board to a collection with `index` and `views`, not to one fat watched
   query (`MIGRATION.md`, "Boards"): that pattern is why the benchmark
   missed its bytes target.
4. **Lobby joins.** They use `ctx.rooms.join` and `ctx.rooms.emit` with
   events declared in the contract (`usePresence` for who is there): at
   most 100 app rooms per socket, `qd:` and `user:` names refused, and no
   joins inside a `share`d query.
5. **Its channel.** 5.0 drops anonymous senders, and a channel's `requires`
   can name only an entity or collection subscription the sender holds,
   not an app room as 4.x's `requireRoom` could.

## Suggested order

1. Codemod; contracts with real schemas; access.
2. The collections and boards, with emits deleted once each is declared.
3. The client: typed hooks, then the optimistic layer removed screen by
   screen.
4. Lobbies on `ctx.rooms`, and the channel.
5. The MCP loop onto the bridge, last: it reads the finished contracts.
6. Budgets for a board's first load and a write with many viewers.
