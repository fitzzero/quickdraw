# 5.0 release checklist

The steps from the 5.0 integration branch (`dev`) to quickdraw 5.0.0 on npm.
The owner releases: agents never push tags or run `npm publish`
([`releasing.md`](releasing.md)). The release gate is an owner decision:
5.0.0 reaches `main` only after every pack is done, the final review and
checks pass, and quickdraw-chat has been migrated and validated against the
release candidate.

Written by pack G's release candidate card on 2026-10-03; rewritten by pack
I's release preparation card on 2026-10-05, when parts 1 to 4 were done and
`dev` held 5.0.0. Part 5 is what remains, the owner's steps in order.

## 1. Build 5.0 on `dev`

- [x] Packs A to F merged to `dev`: A `d9bd68b` (#13), B `8a44ae0` (#19),
      C `517c9ad` (#25), D `b5ac960` (#30), E `1dca1c1` (#37), F `341ccee`
      (#41).
- [x] Pack G (the benchmark, the codemod and migration guide, the release
      candidate and the upgrade briefs) merged to `dev` (`1429b82`, #45),
      with its finale round's fixes and its independent review's fixes A
      to G; the round is recorded in RFC 0003 section 17.
- [x] Pack H (agent guardrails, the multi-node proof and non-JS clients)
      merged to `dev` (`69b0da3`, #50) after its finale review and two
      fixer rounds, with CI green (the path-gated `cluster` and `godot`
      jobs included).
- [x] The 4.1.1 hotfix merged on `main` (`daf3d48`, #46), and `main` merged
      into `dev` (#53), so `dev` merges into `main` without conflicts;
      `release/4.x` keeps 4.x at `daf3d48`.

## 2. Publish the release candidates

- [x] npm trusted publishing set up for all four packages: lint, skills and
      codemod were first published by hand at `5.0.0-rc.1`, and every
      version from `5.0.0-rc.2` on was published by `publish.yml` with
      provenance.
- [x] `5.0.0-rc.1` (#51, pack H on top of `5.0.0-rc.0`, which was never
      published) to `5.0.0-rc.7` (#71) published under `next` for all four
      packages, each from a version-bump pull request into `dev` and its
      four tags pushed one at a time: rc.2 (#56), rc.3 (#58), rc.4 (#62),
      rc.5 (#64), rc.6 (#67), rc.7 (#71). Until 5.0.0 took `latest` for
      all four, core's `latest` was 4.1.0, and lint's, skills' and
      codemod's was `5.0.0-rc.1` (their first, hand publish).
- [x] The benchmark rerun on the final code (`5.0.0-rc.6`), with the
      template's netcode measured on 4.x and 5.0: `bench/reports/5.0.0.md`
      and `docs/benchmarks.md` (#68). rc.7 changed the client's overlay
      store and the auth routes only, so its figures stand.

## 3. Prove it on quickdraw-chat (the release gate)

- [x] quickdraw-chat migrated on the release candidates, as a pack on its
      own Conveyor project (fitzzero/quickdraw-chat #46 to #51 into the
      pack branch, then #52 into its `dev`, `d7ef0a3`, on 2026-10-05), with
      its own suites green (lint on quickdraw-lint's template config,
      typecheck, unit, integration and component tests, budgets,
      `check:godot`), access unchanged against its matrices except the
      changes its pull requests name, and an independent review of the
      migration fixed before it merged.
- [x] Exercised by hand on the release candidate: sign in, chats and
      messages in two browsers, sharing, reconnecting, the game with two
      Godot clients; then deployed as the hosted dev instance, where the
      owner's QA found F9.1 to F9.3 (fixed in quickdraw-chat #53, and with
      F10.1 to F10.4 from checking that fix, in `5.0.0-rc.6`).
- [x] Findings fed back as framework fixes, each round its own release
      candidate: F1 to F7 in rc.2 to rc.5 (#55, #57, #59, #60, #61, #63),
      F8.1 and F8.2 in the docs (#65), and the final independent review of
      rc.2 to rc.5 with F8.3 to F8.6 and the owner's QA in rc.6 (#66).
      The template then moved to rc.6 (fitzzero/quickdraw-chat #54), where
      nothing broke on the plain upgrade, and filed F11.1 to F11.4 (an
      optimistic item a load ended without a re-render, the provider
      list's rate limit, `requireSession` without an origin list,
      `newId()`), fixed in rc.7 (#70); it runs rc.7 (its #55), with a test
      that fails on rc.6 and passes on rc.7. Its pull requests
      (fitzzero/quickdraw-chat #46 to #56) are the worked example.

## 4. Prepare 5.0.0 on `dev`

- [x] `packages/core/legacy-src` removed with its ignores and excludes;
      the 122 citations of it in comments read 4.1 `src/<path>:<line>`,
      lines of the `release/4.x` branch (`CONTRIBUTING.md`).
- [x] `5.0.0` in all four `package.json` files, the codemod's ranges on
      core and lint (`^5.0.0`), `QUICKDRAW_VERSION` and its test, and the
      workspace entries of `bun.lock`, by hand
      (`bun install --frozen-lockfile` passes).
- [x] The install commands off `@next` (`README.md`, `MIGRATION.md`,
      `UPGRADE-PROMPT.md`, the lint, skills and codemod READMEs, the
      `quickdraw-migrate-v5` skill), and the
      links the shipped copies make to GitHub on `main`
      (`packages/core/test/readme/packageFiles.ts`, the README's links to
      the example app).
- [x] One `[5.0.0]` entry at the top of `CHANGELOG.md`, the release
      candidates' entries kept below it; its date is left to step 5.3.
- [x] The downstream briefs refreshed (`docs/downstream/`; removed after
      the release, when each app's outline moved to a card on its own
      Conveyor project: step 5.8).
- [x] The final checks: the gates, the dist smoke test,
      `npm pack --dry-run`, publint and arethetypeswrong green, and for all
      four packages `bash scripts/release-tag.sh <package> 5.0.0` ready (no
      tag made); `git merge-tree --write-tree origin/main` with `dev`
      reports no conflict (`main` is an ancestor of `dev`). The built
      `dist` differs from `5.0.0-rc.7`'s only in the version and in
      comments (compared again after rc.7 was merged in).

## 5. Owner steps, in order

1. [x] **The gate.** quickdraw-chat ran `5.0.0-rc.7` with its checks
       green (fitzzero/quickdraw-chat #55), 5.0.0 is that candidate's code
       with the version changed, and the owner released after their QA of
       the hosted template (https://quickdraw-dev.techtree.gg).
2. [ ] **4.1.1, if it is still wanted** (the 4.x apps' fix for a socket
       event with a numeric name crashing the server). It was not
       published before 5.0.0, so it now needs a dist-tag of its own, or
       it would take `latest` back from 5.0.0 (`docs/releasing.md`, "Which
       dist-tag"; a dist-tag must not read as a semver range, so not
       `v4`). It sits on `release/4.x` (`daf3d48`, `package.json` 4.1.1),
       which has no Publish workflow, so it goes out by hand from a clean
       checkout of that branch (a worktree leaves the 5.0 checkout's
       install alone):

   ```bash
   git worktree add ../quickdraw-4.x release/4.x
   cd ../quickdraw-4.x && bun install
   npm publish --tag latest-4   # prepublishOnly builds; latest stays 5.0.0
   ```

   An app on `^4.1.0` takes it with `bun update @fitzzero/quickdraw-core`.

3. [x] **Date the changelog**: `## [5.0.0] - 2026-10-05` (`CHANGELOG.md`),
       set on `dev` before the release branch was cut. If the tags go out
       on a later day, change the date on the release branch before it
       merges.
4. [x] **Released `dev` to `main`** through Conveyor on 2026-10-05:
       `release/2026.10.1` (#73), merge commit `10f8d60`.
5. [x] **Tagged 5.0.0 on `main`** on 2026-10-05, at the release's merge
       commit (`10f8d60`), one package at a time (`core`, `lint`, `skills`,
       `codemod`); each Publish run published with provenance. How it was
       done, for the next release:

   ```bash
   git switch main && git pull
   bash scripts/release-tag.sh core 5.0.0   # prints core-v5.0.0
   git tag -a core-v5.0.0 -m "@fitzzero/quickdraw-core 5.0.0"
   git push origin core-v5.0.0
   ```

   Then the same for `lint`, `skills` and `codemod`, each tag in a
   `git push` of its own: GitHub starts no workflow when more than three
   tags arrive in one push. Each Publish run publishes under `latest`.

6. [ ] **The dist-tags.** `latest` is `5.0.0` for all four packages
       (checked on 2026-10-05). Still to do, by the owner (it needs npm's
       two-factor step): move `next` to 5.0.0 too, so `@next` never
       resolves to an older release candidate (it reads `5.0.0-rc.7`):
       `npm dist-tag add @fitzzero/quickdraw-<package>@5.0.0 next` for
       `core`, `lint`, `skills` and `codemod`.
       Once an automated publish has worked, step 3 of the one-time setup
       (two-factor publishing, tokens disallowed) is open
       ([`releasing.md`](releasing.md)).
7. [x] **quickdraw-chat on 5.0.0** (fitzzero/quickdraw-chat #56,
       2026-10-05): its ranges are `^5.0.0`, nothing else changed. Its own
       release to `main` is the owner's.
8. [x] **The other apps' outline cards** (2026-10-05): one card on each
       app's own Conveyor project, unidentified, with the summary of 5.0,
       the tools, the steps every app follows and that app's hazards and
       suggested order: seneschal (a re-fork from the 5.0 template instead
       of a migration), x-tokage-siege, foundation, farseer and Conveyor.
       Each project's planner turns its card into the migration pack and
       recounts first. The briefs that were in `docs/downstream/` are
       removed; the cards carry them. makiel and quickdraw-sunfall stay on
       3.x and have no card.
