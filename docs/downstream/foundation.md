# foundation: upgrade brief

On 4.1.0. Third in line: the first large app, with the most collections of
any app the audit counted, and its own lint rules, two of which quickdraw's
lint package was ported from.

## Size

18 services, 136 methods and 13 collections (the audit of 2026-10-02);
223 handlers return `{ error }` instead of throwing. Run the codemod's dry
run for the report's counts before planning.

## Top hazards

1. **223 handlers return `{ error }`.** In 5.0 a returned object is a
   successful reply: nothing rejects, and `{ error }` reaches the caller as
   data only where the output schema declares it. Each becomes a thrown
   `QuickdrawError` with a code that says what happened (`NOT_FOUND`,
   `FORBIDDEN`, `VALIDATION`, `CONFLICT`), and callers read `error.code`
   from the rejected call. A plain `Error` is no
   substitute: it reaches the caller as `INTERNAL` with a generic message.
   The codemod does not rewrite these returns; it marks a thrown `Error`
   whose message 4.x sent (`[error]`).
2. **Thirteen collections.** Each becomes a contract collection (a scope
   column or `via`, `order` columns ending in `id`, an anchor in
   `defineService`); deltas then follow tracked writes, so every write path
   into those models goes through `db` or records what it changed with
   `ctx.touch`. A count read from a junction needs `refreshEntry: true`; a
   write that sets a value the row already held still signals.
3. **Its local lint rules.** `no-foreign-prisma-writes` is superseded by
   `no-foreign-write`: each service lists the other models it writes in
   `writes`, and foundation's model-owner map is where those lists come
   from. The local copies of `no-cross-service-internal-imports` and
   `no-prisma-in-routes` give way to the package's rules, which were ported
   from them. Delete the local rules and adopt the package with
   `quickdraw-lint baseline` and `quickdraw-lint check`, which applies the
   baseline to oxlint's own rules too.
4. **Access in code.** Each `"Read"` method without a row id becomes a
   marked `"authenticated"` form (4.x let every signed-in user call it), a
   method that takes an `id` under such a form is refused at startup until
   it is decided (`rowless: true` only where every caller may reach every
   row), and each access override becomes a policy.

## Suggested order

1. Codemod and lint with a baseline, then the contracts (with real
   schemas) in one card.
2. A second card for access, emits and the collections, service by
   service, with an access matrix each.
3. The `{ error }` returns, converted with the client code that reads them,
   in the same commits, so no screen is left reading `.error` from data.
4. The `writes` lists from the model-owner map, then budgets for its
   busiest collection.
