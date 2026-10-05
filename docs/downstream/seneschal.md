# seneschal: re-fork from the template

On 4.1.0, close to the template, and small: 5 services and 22 methods (the
audit of 2026-10-02; its collections and channels were not counted). It
does not run the codemod: it re-forks from the migrated quickdraw-chat and
ports its own features onto the fork (an owner decision, 2026-10-04). The
template already holds the 5.0 server, sign-in, typed client, tests, lint
and agent rules seneschal would otherwise rebuild, so what is left to port
is only what seneschal added.

## Top hazards

1. **Knowing what is seneschal's own.** Diff it against the template
   commit it was forked from before planning: each service, route, screen
   and table it added is ported; whatever it kept from the template comes
   from the new fork as it is. Count its collections and channels then.
2. **Access, decided per method.** Each of its own services becomes a 5.0
   service by the `quickdraw-new-service` skill, with a declared form per
   method. 4.x admitted every signed-in user to a `"Read"` method that named
   no row: write the form 4.x actually meant, say so where it changes, and
   pin it with an access matrix.
3. **Its database.** The template's 5.0 migrations apply to a 4.x database
   of the template (quickdraw-chat's `DEPLOYMENT.md`, "Upgrading to
   quickdraw 5.0"); seneschal's own tables follow as migrations on top of
   the fork's. Rehearse the whole cutover on a copy of production: sessions
   end (everyone signs in once more), emails count only once a provider
   verified them, and `ADMIN_EMAILS` admins sign in once through one that
   does.
4. **Its deployment.** The fork's sign-in cookie is `SameSite=Lax`, so the
   web app and the API sit on one site (or the cookie is
   `sameSite: "none"`); a hosted instance off localhost sets `API_URL`, and
   one behind a proxy sets `TRUST_PROXY`.

## Suggested order

1. After the release: fork quickdraw-chat at its `5.0.0` commit with
   `./scripts/init-fork.sh seneschal [port] [--scope @org]`, adding
   `--without-game` and `--without-storybook` for what it does not use.
2. Port seneschal's own features one service per commit: Prisma model and
   migration, contract, service, client hooks, access matrix.
3. Its screens on the typed client; budgets for its busiest screen.
4. The cutover rehearsed on a copy of production data, then shipped server
   and web together (`legacyWire: true` only if another 4.x client
   remains).
