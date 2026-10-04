# seneschal: upgrade brief

On 4.1.0. Close to the template, and small: migrate it straight after
quickdraw-chat, using quickdraw-chat's finished migration as the worked
example and starting from a release candidate that carries whatever
quickdraw-chat turned up.

## Size

5 services and 22 methods (the audit of 2026-10-02). Its collections and
channels were not counted: the migration card counts them, and runs the
codemod's dry run for the report's counts, before planning.

## Top hazards

The audit records no seneschal-specific findings. Because it follows the
template, expect quickdraw-chat's template-level hazards; confirm each one
against the code before planning:

1. **The copied bootstrap and auth files.** The template's server
   bootstrap and auth files become `qd.createServer`, `createAuthRoutes` and
   `socketAuth`, with a `SessionStore` over the app's own session model.
   The new tokens carry a session id (`sid`), so everyone signs in once
   more; in production pass `cookieName: "__Host-session"` to `socketAuth`
   until the release candidate carries the `__Host-` hardening.
2. **Access the template decided in code.** `checkEntryACL` or
   `checkAccess` overrides become policies (`owner`, `jsonAcl`, `members`,
   `inherit`); until each is ported, the codemod's placeholder grants no
   row. Every `"Read"` method without a row id becomes a marked
   `"authenticated"` form: 4.x let every signed-in user call it.
3. **Hand emits and the CRUD helpers.** Writes move to the tracked `db`;
   `this.update` returned `null` for a missing row where `db` throws
   `NOT_FOUND`; lifecycle hooks no longer run, so their work moves into the
   methods that write; hand emits are deleted once each collection is
   declared in its contract.
4. **The template's typed hook wrappers and admin hooks.** The codemod
   rewrites hook calls onto the typed client and deletes the wrappers;
   admin screens that name services at run time move to
   `qd.<service>.admin.*` by hand.

## Suggested order

1. Wait for quickdraw-chat's migration to merge, and for the release
   candidate with its fixes.
2. Follow [`MIGRATION.md`](../../MIGRATION.md) in one card: codemod, then
   contracts, access, emits, client, each a commit.
3. Lint presets, `quickdraw-skills link`, budgets for its busiest screen.
4. Ship the server and web client together unless another client (mobile,
   a script) still speaks 4.x; then use `legacyWire: true` for the
   rollout.
