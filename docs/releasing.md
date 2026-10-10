# Releasing

**A release is a merge to `main`.** `.github/workflows/publish.yml` runs on
every push to `main` and publishes what that push released, to npm, with
provenance, under npm trusted publishing (a short-lived token exchanged for
the job's GitHub OIDC token, so no npm token is stored in the repository).
There is no tag to push, no workflow to start, and no version to remember.

Nothing else publishes. A push to `dev`, a pull request, a merge into a
feature branch: none of them reach npm.

## What a push to `main` does

[`scripts/auto-release.sh`](../scripts/auto-release.sh) decides, from the four
packages' version (they share one, the framework's) and the registry:

- **The version in the repository is not on npm.** That is the release:
  publish it. Somebody bumped it deliberately — a patch with its CHANGELOG
  entry, a minor, a major.
- **It is on npm, and a package's shipped source changed since the
  `core-v<version>` tag of that release.** Nobody bumped, so the script does,
  by the patch: it writes the new version into `packages/*/package.json`,
  `packages/core/src/version.ts` and `bun.lock`, dates the CHANGELOG's
  `## [Unreleased]` heading if there is one, and the workflow commits that on
  `main` before publishing it.
- **It is on npm and nothing shipped changed.** Nothing to publish.

Then the workflow publishes every package npm does not already have at that
version, and tags the release `<package>-v<version>` for each package that is
on npm at it. The tags are records, and the anchor the next push diffs
against; nothing is triggered by them.

Every step asks the registry, so the whole thing is idempotent: re-running a
run, or pushing to `main` again, publishes only what is missing. A release
whose publish half failed is finished by the next push to `main`.

**Shipped source** is what npm hands a consumer, by each package's `files`
list: `packages/core/src`, `packages/lint/plugin`, `bin` and the two
`oxlint.*.jsonc`, `packages/skills/rules`, `skills` and `bin`,
`packages/codemod/src` and `bin`, and the four manifests. Tests, `dist`, and
Markdown are not — except under `packages/skills`, whose rules and skills
_are_ Markdown. So a docs change, a test, a benchmark, the Godot example or a
workflow never cuts a release on its own; a change to the published code
always does.

To see what a push would do before making it, run the script. It never
reaches the network, so it is told whether the version is published:

```bash
bash scripts/auto-release.sh              # as if the version were unpublished
bash scripts/auto-release.sh --published  # as if it were already on npm
```

## Releasing a version

For a patch, there is nothing to do: write the change, merge `dev` into `main`,
and the patch publishes itself. Write the entry under a `## [Unreleased]`
heading in `CHANGELOG.md` and the release puts the version and the date on it.

For a **minor or a major**, bump it yourself on `dev` — the machine only ever
takes the patch:

1. Set the same new version in all four `packages/*/package.json`, in
   `packages/core/src/version.ts`, and in `bun.lock` (`bun install` writes it),
   and head the CHANGELOG entry with it. A test holds the four manifests to one
   version and `QUICKDRAW_VERSION` to core's, so a half-done bump fails CI.
2. For a **major**, widen `packages/codemod`'s devDependencies on core and
   lint (`^5.0.0`): bun links them to the workspace packages only while the
   range matches, and npm ships the manifest as it is.
3. Merge to `main`. The version is not on npm, so it publishes as it is.

A prerelease (`5.1.0-rc.1`) is never bumped by machine: publish it, and the one
after it, by bumping on `dev` as above. It goes out under `next` (below).

The bump the workflow commits is pushed to `main`, and to `dev` as well when
that is a fast-forward — right after a release merge it usually is, which saves
the sync; when `dev` has moved on, merge `main` into `dev` as usual. A commit
pushed with `GITHUB_TOKEN` starts no workflow run, so that commit gets no CI of
its own (and cannot start a second release); it only moves version strings, and
the publish job's install and build are the only check it gets before npm.

## Packages and tags

| Package                       | Directory          | Release tag          |
| ----------------------------- | ------------------ | -------------------- |
| `@fitzzero/quickdraw-core`    | `packages/core`    | `core-v<version>`    |
| `@fitzzero/quickdraw-lint`    | `packages/lint`    | `lint-v<version>`    |
| `@fitzzero/quickdraw-skills`  | `packages/skills`  | `skills-v<version>`  |
| `@fitzzero/quickdraw-codemod` | `packages/codemod` | `codemod-v<version>` |

All four packages are public. The workflow refuses to publish a package marked
`private`, and so does `scripts/release-tag.sh`, which validates a release and
prints its tag (a clean tree, a semantic version, the manifest at that version)
without creating anything.

`npm publish` ships a package's `package.json` as it is, and npm does not know
bun's `workspace:` ranges, so no published package names one: the codemod's
devDependencies on core and lint are semver ranges (`^5.0.0`), which bun links
to the workspace packages all the same while their versions match.
`packages/core/test/readme/readme.test.ts` checks the four manifests.

Pushing a release tag by hand publishes nothing. It used to be the whole
release, and that is why this moved to the merge: GitHub creates no push event
when more than three tags arrive in one push, so the four tags of `5.0.0-rc.2`
went up and started nothing, and 5.0.1's tags were never pushed at all, so
5.0.1 sat unpublished on `main`.

For 5.0, the sequence from the release candidates to 5.0.0 is
[`release-checklist-5.0.md`](release-checklist-5.0.md), which describes the
tag-pushing release this replaced.

## Which dist-tag

A version with a prerelease part (`5.0.0-alpha.1`, `5.1.0-rc.0`) is published
under the `next` dist-tag, so `npm install @fitzzero/quickdraw-core` keeps
resolving to the current release. Any other version is published under
`latest`. The workflow leaves `latest` implicit, which keeps npm's own guard:
npm refuses to move `latest` back to a version lower than one already
published, so a hotfix for an older major has to be published by hand with an
explicit `--tag`.

A 4.x release (4.1.1 is on `release/4.x`, at `daf3d48`) is published by hand
from a clean checkout of that branch: `bun install`, then
`npm publish --tag latest-4`, whose `prepublishOnly` builds. 5.x holds `latest`
since 5.0.0 (2026-10-05), so a 4.x release needs that tag of its own (a
dist-tag must not read as a semver range, so not `v4`).

## Publishing by hand

To publish from somewhere other than a push to `main` — an older commit, a
branch, a package whose run failed after the others went out — open the Publish
workflow in the Actions tab, choose "Run workflow", pick the ref under "Use
workflow from", and the `package` (one, or `all`). It publishes that ref
exactly as it is: no bump, no commit. `version` is an optional guard that
refuses the run unless that ref's `package.json` is at it. From a terminal:

```bash
gh workflow run publish.yml --ref main -f package=core -f version=5.0.2
```

A version already on npm is skipped, so a run by hand can never republish or
clobber anything, and re-running one is safe.

## One-time npm setup for each package

Trusted publishing has to be configured on npmjs.com once per package, and npm
only allows that for a package that already exists. Until it is done for a
package, that package's Publish runs fail at the publish step.

1. **Publish the first version by hand** if the package has never been
   published:

   ```bash
   npm login
   cd packages/lint                         # then packages/skills, packages/codemod
   npm publish --access public --tag next   # a prerelease needs --tag
   ```

   A package with a build step (core, codemod) needs `bun install` and
   `bun run build` at the repository root first. All four exist on npm since
   5.0.0, so this is for a fifth package.

2. **Add the trusted publisher.** On npmjs.com, open the package, then
   Settings, then Trusted Publisher, choose GitHub Actions, and enter:
   - Organization or user: `fitzzero`
   - Repository: `quickdraw`
   - Workflow filename: `publish.yml`
   - Environment: leave empty

   That filename is load-bearing: npm checks it against the OIDC claim of the
   job that publishes. Renaming `publish.yml`, or moving `npm publish` into a
   reusable workflow (whose own path the claim would then carry), stops all
   four packages publishing until the trusted publishers are changed to match.

3. **Optional, once an automated publish has worked:** on the same settings
   page, set publishing access to require two-factor authentication and
   disallow tokens, so only the workflow (and you, with 2FA) can publish.

Trusted publishing needs npm 11.5.1 or newer. The Node 24 release that
`.nvmrc` resolves to ships a new enough npm, and the workflow checks the
version before publishing.
