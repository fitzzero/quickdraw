# foundation: upgrade brief

On 4.1.0. Fourth in line: the first large app, with the most collections
of any app the audit counted, and its own lint rules, two of which
quickdraw's lint package was ported from.

## Size

18 services, 136 methods and 13 collections (the audit of 2026-10-02);
223 handlers return `{ error }` instead of throwing. Run the codemod's dry
run for the report's counts before planning.

## Top hazards

1. **223 handlers return `{ error }`.** In 5.0 a returned object is a
   successful reply: the caller receives `{ error }` as data, nothing
   rejects, and the contract's output schema has to allow it. Each becomes
   a thrown `QuickdrawError` with a code that says what happened
   (`NOT_FOUND`, `FORBIDDEN`, `VALIDATION`, `CONFLICT`), and callers read
   `error.code` from the rejected call. A plain `Error` is no substitute:
   it reaches the caller as `INTERNAL` with a generic message. The codemod
   does not rewrite these.
2. **Thirteen collections.** Each becomes a contract collection (a scope
   column or `via`, `order` columns ending in `id`, an anchor in
   `defineService`); deltas then follow tracked writes, so every write path
   into those models has to go through `db`, or record what it changed
   with `ctx.touch`.
3. **Its local lint rules.** `no-foreign-prisma-writes` is superseded by
   `no-foreign-write`: each service lists the other models it writes in
   `writes`, and foundation's model-owner map is where those lists come
   from. The local copies of `no-cross-service-internal-imports` and
   `no-prisma-in-routes` give way to the package's rules, which were ported
   from them; delete the local rules and adopt the package with a
   baseline.
4. **Access in code.** As in every 4.x app, each `"Read"` method without a
   row id becomes a marked `"authenticated"` form (4.x let every signed-in
   user call it), and each access override becomes a policy.

## Suggested order

1. Codemod, then the contracts (with real schemas) in one card.
2. A second card for access, emits and the collections, service by
   service.
3. The `{ error }` returns, converted with the client code that reads them,
   in the same commits, so no screen is left reading `.error` from data.
4. Lint: the package's base config, the `writes` lists, a baseline for the
   rest; then budgets for its busiest collection.
