# 5.0 release checklist

The steps from the 5.0 integration branch (`dev`) to quickdraw 5.0.0 on npm,
in order. The owner publishes: agents never push tags or run `npm publish`
([`releasing.md`](releasing.md)). The release gate is an owner decision:
5.0.0 reaches `main` only after every pack is done, the final review and
checks pass, and quickdraw-chat has been migrated and validated against the
release candidate.

Written by pack G's release candidate card on 2026-10-03, with that day's
state; tick each item as it is done.

## 1. Finish 5.0 on `dev`

- [x] Packs A to F merged to `dev`: A `d9bd68b` (#13), B `8a44ae0` (#19),
      C `517c9ad` (#25), D `b5ac960` (#30), E `1dca1c1` (#37), F `341ccee`
      (#41). CI green on `dev` at `341ccee`.
- [ ] Pack G's children 1 to 3 merged on the pack branch
      (`ft/quickdraw-5-0-pack-g-benchmark-proof-migration-tooling-and-r`):
      the benchmark (#42), the codemod and migration guide (#43), and this
      release candidate with the upgrade briefs.
- [ ] Pack G's finale round puts these fixes in the release candidate
      (on the pack branch, each with its tests; the RFC entry is left):
  - [x] a shared run's result is stripped and JSON-encoded once per group
        of callers whose levels hide the same fields, not once per caller,
        and the socket transport sends each caller of a group the same
        bytes (the event-loop delay regression in `bench/reports/5.0.0.md`;
        not measured again, a benchmark rerun being the owner's call);
  - [x] the default socket rate limit is 600 events per minute per socket,
        in `createServer` and in `createRateLimiter()`; `bench/apps/v5`
        runs at the default, which its workload stays under;
  - [x] `<QuickdrawProvider reconnectJitterMs>`, the longest random delay
        before a watched or stale query is refetched after a reconnect:
        2,000 ms by default, `0` at once (`jitterMs` on the coordinator's
        `refetchAfterReconnect`);
  - [x] the two `defineService` typing fixes: an unannotated function `id`
        selector in one method no longer widens `ctx.principal` to nullable
        in every other method, and `MethodImplementation<…, "authenticated">`
        with `satisfies` takes every form but `"public"`,
        `{ service, entry }` included; the codemod dropped its workarounds
        (unannotated `id` functions, `MethodOf` typed for `"authenticated"`);
  - [x] the `__Host-` hardening: without a configured `cookieName`,
        `socketAuth` and the HTTP transport read the plain `session` cookie
        over HTTPS only when the cookie has a domain, so a planted plain
        cookie cannot stand in for `__Host-session`; the routes,
        `setSessionCookie` and the transports name the cookie by one rule
        (`sessionCookieNameFor`, review fix A), the transports read
        `COOKIE_DOMAIN`, and a `cookie.domain` given only to the routes
        warns at startup until it is named;
  - [x] the docs follow the fixes: `README.md` and `MIGRATION.md`
        ("Defaults that changed") say 600, `reconnectJitterMs` and the
        cookie rule; the `cookieName: "__Host-session"` advice is gone from
        [`downstream/quickdraw-chat.md`](downstream/quickdraw-chat.md) and
        [`downstream/seneschal.md`](downstream/seneschal.md); the
        `5.0.0-rc.0` entry of `CHANGELOG.md` lists exactly what shipped; and
        `bun run readme:sync` (in `packages/core`) and `bun run guide:sync`
        (in `packages/codemod`) have copied the guide;
  - [ ] the round's decisions are recorded in RFC 0003 section 17.
- [ ] Pack G merged to `dev`, so all seven packs are on `dev`.
- [ ] CI green on `dev` at that merge commit.
- [ ] The benchmark report committed and reviewed: `bench/reports/5.0.0.md`
      (measured on 5.0.0-alpha.0, before the finale round).
- [ ] The codemod fixture passing in that CI run: the `packages/codemod`
      tests (the fixture's snapshot, its output typechecking against the
      built core and passing lint apart from its markers, a second run
      changing nothing).

## 2. Publish the release candidate (owner)

- [ ] npm trusted publishing set up for all four packages (the registry as
      of 2026-10-03; the setup steps are in [`releasing.md`](releasing.md),
      "One-time npm setup for each package"):

  | Package                       | On npm                                    | One-time setup                                                    |
  | ----------------------------- | ----------------------------------------- | ----------------------------------------------------------------- |
  | `@fitzzero/quickdraw-core`    | yes: `latest` is 4.1.0, no `next` tag yet | step 2 only, unless npmjs.com already lists the trusted publisher |
  | `@fitzzero/quickdraw-lint`    | no                                        | step 1 (first version by hand), then step 2                       |
  | `@fitzzero/quickdraw-skills`  | no                                        | step 1, then step 2                                               |
  | `@fitzzero/quickdraw-codemod` | no                                        | step 1 (it has a build step), then step 2                         |

  The first hand publish can be `5.0.0-rc.0` itself, from the commit the
  release candidate is tagged on (`npm publish --access public --tag next`
  in the package's directory). Pushing that package's tag afterwards is
  harmless, since the workflow skips a version already on npm, and keeps
  the tag record. A hand-published version has no provenance.

- [ ] Tag the release candidate on `dev` at the pack G merge commit (or a
      later one) with a clean tree, for each of `core`, `lint`, `skills` and
      `codemod`:

  ```bash
  bash scripts/release-tag.sh core 5.0.0-rc.0   # prints core-v5.0.0-rc.0
  git tag -a core-v5.0.0-rc.0 -m "@fitzzero/quickdraw-core 5.0.0-rc.0"
  git push origin core-v5.0.0-rc.0
  ```

- [ ] The four Publish runs are green, each package's `next` dist-tag is
      `5.0.0-rc.0` (`npm view @fitzzero/quickdraw-core dist-tags`), and
      core's `latest` is still 4.1.0.
- [ ] The published codemod gives the repository's dry run: in a copy of
      quickdraw-chat at the commit
      [`downstream/quickdraw-chat.md`](downstream/quickdraw-chat.md) names,
      `bunx @fitzzero/quickdraw-codemod@next v5 . --dry-run` prints the
      totals it lists.
- [ ] The benchmark rerun against the published release candidate, or a
      recorded decision not to. RFC 0003 section 17 leaves a rerun against
      the published build and a heap snapshot after reconnect-storm open;
      the shared-reply fix should bring event-loop delay p99 back toward
      4.1's.

## 3. Prove it on quickdraw-chat (the release gate)

- [ ] A migration card on the quickdraw-chat project, drafted from
      [`downstream/quickdraw-chat.md`](downstream/quickdraw-chat.md).
- [ ] quickdraw-chat migrated on a branch against `5.0.0-rc.0`, with its own
      test suites green (lint on the 5.0 base config, typecheck, unit and
      integration tests).
- [ ] quickdraw-chat exercised by hand against the release candidate: sign
      in, create and rename a chat, send messages in two browsers, share and
      unshare a document, reconnect after going offline.
- [ ] Findings from that migration fed back: each awkward spot fixed in
      quickdraw as a framework bug, or filed as a follow-up card. A fix to
      the packages ships as a new release candidate (`5.0.0-rc.1`: versions,
      CHANGELOG, then part 2 again), and quickdraw-chat is checked again on
      it.

## 4. Release 5.0.0

- [ ] `legacy-src` removed: delete `packages/core/legacy-src/`, its ignore
      in `.oxlintrc.json` (`**/legacy-src/**` in `ignorePatterns`) and in
      `.oxfmtrc.json`, its excludes in `packages/core/tsconfig.json` and
      `packages/core/vitest.config.ts`, and its sections of `CLAUDE.md` and
      `CONTRIBUTING.md`. About 120 source comments cite
      `legacy-src/<path>:<line>`; those are the same lines of 4.1.0's
      `src/<path>` (`main` at `f767f68`), so the citations stay readable.
- [ ] The final version set: `5.0.0` in all four `package.json` files, in
      `QUICKDRAW_VERSION` (`packages/core/src/version.ts`) and its test
      (`packages/core/src/index.test.ts`), and in the workspace entries of
      `bun.lock` (bun does not rewrite them itself); a dated `5.0.0` entry in
      `CHANGELOG.md`; the install commands moved from `@next` to the release
      in `README.md`, `MIGRATION.md` (then `readme:sync`),
      `UPGRADE-PROMPT.md`, `packages/codemod/README.md` and the
      `quickdraw-migrate-v5` skill; the full gate, the dist smoke test,
      publint and arethetypeswrong green; and for all four packages,
      `bash scripts/release-tag.sh <package> 5.0.0` clean.
- [ ] The final review and checks pass on `dev` (the owner's release gate).
- [ ] 4.1.1 out for the apps still on 4.x: the card
      `4-1-1-hotfix-socket-rate-limiter-crashes-the-process-on-a-no` (in
      Planning on 2026-10-03), merged to `main` and published by hand from
      there, since `main` has no Publish workflow. It waits for nothing in
      this list, so ship it as early as possible, but no later than here:
      it is built from `main`, which stops being 4.x once `dev` is merged,
      and once 5.0.0 takes `latest`, npm refuses to give 4.1.1 the implicit
      `latest` tag without an explicit `--tag`.
- [ ] `dev` merged to `main` (the card "Release quickdraw-core 5.0.0 to
      main" opens the pull request; the owner merges it). With 4.1.1 on
      `main`, resolve the conflicts in favor of `dev` (the 4.x `src/` tree
      and its root `package.json` are gone there), except `CHANGELOG.md`,
      which keeps the `4.1.1` entry below `5.0.0`. 5.0 already has the guard
      4.1.1 adds (`packages/core/src/server/rateLimit.ts`).
- [ ] 5.0.0 published by the owner from `main`: the tags `core-v5.0.0`,
      `lint-v5.0.0`, `skills-v5.0.0` and `codemod-v5.0.0`, published under
      `latest`. Then point `next` at it as well, for each package
      (`npm dist-tag add @fitzzero/quickdraw-core@5.0.0 next`), so `@next`
      never resolves to an older release candidate. Once an automated
      publish has worked for a package, step 3 of the one-time setup
      (require two-factor publishing, disallow tokens) is open.

## After the release

- [ ] One migration card per app, in the order of
      [`downstream/README.md`](downstream/README.md), each drafted from its
      brief and recounting first.
