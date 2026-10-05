# Releasing

Publishing is done by the owner. Nothing is published on merge: the owner
pushes a release tag, or runs the Publish workflow by hand, and
`.github/workflows/publish.yml` publishes that one package at that version to
npm. It uses npm trusted publishing (a short-lived token exchanged for the
job's GitHub OIDC token) with provenance, so no npm token is stored in the
repository.

Agents never bump versions for a release, create or push tags, or publish.

## Packages and tags

| Package                       | Directory          | Release tag          |
| ----------------------------- | ------------------ | -------------------- |
| `@fitzzero/quickdraw-core`    | `packages/core`    | `core-v<version>`    |
| `@fitzzero/quickdraw-lint`    | `packages/lint`    | `lint-v<version>`    |
| `@fitzzero/quickdraw-skills`  | `packages/skills`  | `skills-v<version>`  |
| `@fitzzero/quickdraw-codemod` | `packages/codemod` | `codemod-v<version>` |

All four packages are public. The workflow and `scripts/release-tag.sh`
refuse to release a package marked `private`.

`npm publish` ships a package's `package.json` as it is, and npm does not
know bun's `workspace:` ranges, so no published package names one: the
codemod's devDependencies on core and lint are semver ranges
(`^5.0.0-rc.6`), which bun links to the workspace packages all the same
while their versions match. `packages/core/test/readme/readme.test.ts`
checks the four manifests.

For 5.0, the whole sequence from the release candidate to 5.0.0 on `main`
is [`release-checklist-5.0.md`](release-checklist-5.0.md).

## Release a version

1. Bump `version` in `packages/<package>/package.json`, add a CHANGELOG entry,
   and merge that change.
2. Check out the merged commit with a clean working tree and run:

   ```bash
   bash scripts/release-tag.sh core 5.0.0-alpha.1
   ```

   It checks that the tree is clean, that the version is a semantic version
   (`MAJOR.MINOR.PATCH`, optionally with a `-prerelease`, no `+build`
   metadata) and that it equals the package's `package.json`, then prints the
   tag, here `core-v5.0.0-alpha.1`. It never creates or pushes anything.

3. Tag the commit and push the tag:

   ```bash
   git tag -a core-v5.0.0-alpha.1 -m "@fitzzero/quickdraw-core 5.0.0-alpha.1"
   git push origin core-v5.0.0-alpha.1
   ```

   GitHub runs the Publish workflow as it exists in the tagged commit, so the
   commit must contain `.github/workflows/publish.yml`. Until 5.0 is released
   that means a commit on `dev`; `main` is still 4.1 and has no workflow.

   Push release tags one at a time (one `git push origin <tag>` each), never
   several in one push: GitHub creates no push events, so runs no workflow,
   when more than three tags are pushed at once (found publishing
   `5.0.0-rc.2`, whose four tags went up together and started nothing). If
   that happened, run the workflow by hand for each package (below) rather
   than deleting and pushing the tags again.

4. Watch the Publish run under the repository's Actions tab. It fails before
   publishing anything if the tag's version and the package's `package.json`
   disagree, or if the package is private.

### Which dist-tag

A version with a prerelease part (`5.0.0-alpha.1`, `5.0.0-rc.0`) is published
under the `next` dist-tag, so `npm install @fitzzero/quickdraw-core` keeps
resolving to the current release. Any other version is published under
`latest`. The workflow leaves `latest` implicit, which keeps npm's own guard:
npm refuses to move `latest` back to a version lower than one already
published, so a hotfix for an older major has to be published by hand with an
explicit `--tag`.

### Re-running, and running it by hand

A version that is already on npm is skipped, so re-running a Publish run is
safe.

To publish without pushing a tag, open the Publish workflow in the Actions
tab, choose "Run workflow", pick the ref to publish from under "Use workflow
from" (the release tag, or the branch at the release commit), and enter the
`package` and `version`. The version must equal that ref's `package.json`.
From a terminal:

```bash
gh workflow run publish.yml --ref core-v5.0.0-rc.2 -f package=core -f version=5.0.0-rc.2
```

## One-time npm setup for each package

Trusted publishing has to be configured on npmjs.com once per package, and npm
only allows that for a package that already exists. Until it is done for a
package, that package's Publish runs fail at the publish step.

1. **Publish the first version by hand** if the package has never been
   published. `@fitzzero/quickdraw-core` already exists on npm (4.x), so skip
   this step for it. `@fitzzero/quickdraw-lint`, `@fitzzero/quickdraw-skills`
   and `@fitzzero/quickdraw-codemod` did not exist yet on 2026-10-03:

   ```bash
   npm login
   cd packages/lint                         # then packages/skills, packages/codemod
   npm publish --access public --tag next   # a prerelease needs --tag
   ```

   A package with a build step (core, codemod) needs `bun install` and
   `bun run build` at the repository root first.

2. **Add the trusted publisher.** On npmjs.com, open the package, then
   Settings, then Trusted Publisher, choose GitHub Actions, and enter:
   - Organization or user: `fitzzero`
   - Repository: `quickdraw`
   - Workflow filename: `publish.yml`
   - Environment: leave empty

3. **Optional, once an automated publish has worked:** on the same settings
   page, set publishing access to require two-factor authentication and
   disallow tokens, so only the workflow (and you, with 2FA) can publish.

Trusted publishing needs npm 11.5.1 or newer. The Node 24 release that
`.nvmrc` resolves to ships a new enough npm, and the workflow checks the
version before publishing.
