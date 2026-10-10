#!/usr/bin/env bash
# What a push to `main` publishes, and the version bump it needs.
#
# A release is a merge to `main`: .github/workflows/publish.yml asks this
# script what that merge releases, then publishes it. Two answers do the work:
#
#   * the version in the repository is not on npm — somebody bumped it, for a
#     patch with a CHANGELOG entry or a deliberate minor or major: publish it;
#   * it is on npm, and shipped source changed since that release — nobody
#     bumped, so this script does, by the patch, writing the new version into
#     every place the repository keeps it.
#
# Anything else is nothing to do: a docs- or test-only change never cuts a
# release, and a prerelease version is never bumped by machine.
#
# rallycry/conveyor's scripts/auto-tag-release.sh is the same idea with the
# version in the git tag alone, so that its pull request branches never carry
# one to conflict on. Quickdraw keeps the version in the repository —
# packages/*/package.json, packages/core/src/version.ts (QUICKDRAW_VERSION,
# which the server sends on every handshake) and bun.lock, the first two held
# to each other by a test — so a bump here is a commit, which the workflow
# makes.
#
# The four packages share one version, the framework's; a test holds the four
# manifests to each other, and this script refuses to plan anything while they
# disagree.
#
# Usage:
#   bash scripts/auto-release.sh [--published] [--write] [--date <YYYY-MM-DD>]
#
#   --published  the version in the repository is already on npm. The caller
#                asks the registry; this script never reaches the network.
#   --write      apply the bump it decides on (only `action=bump` has one).
#   --date       the date an auto-bump writes into the CHANGELOG heading
#                (default: today, UTC).
#
# stdout is `key=value` lines and nothing else, so a workflow step can
#   bash scripts/auto-release.sh --published --write >> "$GITHUB_OUTPUT"
# and everything that explains them goes to stderr. The keys:
#
#   action    publish, bump or none
#   version   the version to publish, or to tag as released
#   previous  the version in the repository before any bump
#   anchor    the release tag the shipped-source diff compared against, empty
#             when there is none to compare against yet
#   changed   shipped-source files changed since the anchor
set -euo pipefail
export LC_ALL=C

PACKAGES=(core lint skills codemod)

# A package's shipped source: what npm would hand a consumer, by the `files`
# list of each package.json. Tests, generated output and documentation are cut
# out below, with one exception — @fitzzero/quickdraw-skills ships its rules
# and skills AS Markdown, so .md is shipped source there (conveyor makes the
# same exception for @rallycry/conveyor-skills, whose payload is also
# Markdown). A manifest counts: it carries the dependencies and the export map.
SHIPPED_PATHS=(
  packages/core/src
  packages/core/package.json
  packages/lint/plugin
  packages/lint/bin
  packages/lint/oxlint.base.jsonc
  packages/lint/oxlint.template.jsonc
  packages/lint/package.json
  packages/skills/rules
  packages/skills/skills
  packages/skills/bin
  packages/skills/package.json
  packages/codemod/src
  packages/codemod/bin
  packages/codemod/package.json
)
NOT_SHIPPED='(\.test\.tsx?$|\.test-d\.ts$|/__tests__/|/test/|/dist/)'

fail() {
  echo "auto-release: $*" >&2
  exit 1
}

note() {
  echo "auto-release: $*" >&2
}

published=0
write=0
date_iso=""
while [ "$#" -gt 0 ]; do
  case "$1" in
    --published) published=1 ;;
    --write) write=1 ;;
    --date)
      shift
      date_iso="${1:-}"
      [ -n "$date_iso" ] || fail "--date needs a date"
      ;;
    *) fail "unknown argument '$1' (expected --published, --write or --date)" ;;
  esac
  shift
done
[ -n "$date_iso" ] || date_iso="$(date -u +%F)"

root="$(git rev-parse --show-toplevel 2> /dev/null)" || fail "not inside a git repository"
cd "$root"

# The one version the four packages share.
version=""
for pkg in "${PACKAGES[@]}"; do
  manifest="packages/$pkg/package.json"
  [ -f "$manifest" ] || fail "$manifest does not exist"
  pkg_version="$(node -e '
    const fs = require("fs");
    const manifest = JSON.parse(fs.readFileSync(process.argv[1], "utf8"));
    process.stdout.write(String(manifest.version || ""));
  ' "$manifest")" || fail "could not read $manifest"
  [ -n "$pkg_version" ] || fail "$manifest has no version"
  if [ -z "$version" ]; then
    version="$pkg_version"
  elif [ "$pkg_version" != "$version" ]; then
    fail "$manifest is at $pkg_version, not $version: the four packages share one version"
  fi
done

# Semantic Versioning 2.0.0, prerelease allowed, build metadata refused — the
# same pattern as scripts/release-tag.sh and the publish workflow.
semver='^(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)(-(0|[1-9][0-9]*|[0-9]*[A-Za-z-][0-9A-Za-z-]*)(\.(0|[1-9][0-9]*|[0-9]*[A-Za-z-][0-9A-Za-z-]*))*)?$'
if ! [[ "$version" =~ $semver ]]; then
  fail "'$version' is not a semantic version (MAJOR.MINOR.PATCH with an optional -prerelease)"
fi

# `action=publish`: the version in the repository is not on npm, so it is the
# release, whatever changed. Nothing to decide and nothing to write.
if [ "$published" -eq 0 ]; then
  note "$version is not on npm yet: publishing the version the repository is at."
  printf 'action=publish\nversion=%s\nprevious=%s\nanchor=\nchanged=0\n' "$version" "$version"
  exit 0
fi

anchor="core-v$version"
if ! git rev-parse --verify --quiet "refs/tags/$anchor" > /dev/null 2>&1; then
  # Conveyor seeds a baseline tag on its first run for the same reason: with
  # nothing to diff against, republishing is the only other guess, and it is
  # the wrong one. The workflow tags this release, and the next push to `main`
  # can see what changed since it.
  note "$version is on npm, and there is no $anchor tag to compare against: nothing to release."
  note "The workflow tags it, so the next push to main can see what changed since it."
  printf 'action=none\nversion=%s\nprevious=%s\nanchor=\nchanged=0\n' "$version" "$version"
  exit 0
fi

case "$version" in
  *-*)
    note "$version is on npm and is a prerelease: the next one is cut by hand (bump it on dev)."
    printf 'action=none\nversion=%s\nprevious=%s\nanchor=%s\nchanged=0\n' "$version" "$version" "$anchor"
    exit 0
    ;;
esac

# What of the published packages changed since the release the anchor tags.
changed="$(
  git diff --name-only "$anchor" HEAD -- "${SHIPPED_PATHS[@]}" \
    | grep -Ev "$NOT_SHIPPED" \
    | awk '!/\.md$/ || /^packages\/skills\//' \
    || true
)"
changed_count=0
if [ -n "$changed" ]; then
  changed_count="$(printf '%s\n' "$changed" | grep -c . || true)"
fi

if [ "$changed_count" -eq 0 ]; then
  note "$version is on npm and no shipped source changed since $anchor: nothing to release."
  printf 'action=none\nversion=%s\nprevious=%s\nanchor=%s\nchanged=0\n' "$version" "$version" "$anchor"
  exit 0
fi

next="$(node -e '
  const parts = String(process.argv[1]).split(".");
  process.stdout.write(`${parts[0]}.${parts[1]}.${Number(parts[2]) + 1}`);
' "$version")" || fail "could not bump $version"

note "$version is on npm and $changed_count shipped file(s) changed since $anchor:"
printf '%s\n' "$changed" | sed 's/^/auto-release:   /' >&2
note "Releasing $next."

if [ "$write" -eq 1 ]; then
  node -e '
    const fs = require("fs");
    const [previous, next, isoDate] = process.argv.slice(1);
    const quoted = previous.replace(/[.]/g, "\\.");
    const written = [];

    // Every rewrite says how many places it expects to find, so a file that
    // moves its version somewhere else fails the release instead of shipping
    // a half-bumped tree.
    function rewrite(path, pattern, replacement, expected) {
      const text = fs.readFileSync(path, "utf8");
      const found = [...text.matchAll(pattern)].length;
      if (found !== expected) {
        console.error(
          `auto-release: ${path}: expected ${expected} place(s) at ${previous}, found ${found}`,
        );
        process.exit(1);
      }
      fs.writeFileSync(path, text.replace(pattern, replacement));
      written.push(path);
    }

    for (const pkg of ["core", "lint", "skills", "codemod"]) {
      rewrite(
        `packages/${pkg}/package.json`,
        new RegExp(`("version":\\s*")${quoted}(")`, "g"),
        `$1${next}$2`,
        1,
      );
    }

    // The version the server sends on every handshake.
    rewrite(
      "packages/core/src/version.ts",
      new RegExp(`(QUICKDRAW_VERSION = ")${quoted}(")`, "g"),
      `$1${next}$2`,
      1,
    );

    // bun.lock records each workspace package version. Bun passes a frozen
    // install with a stale one, so nothing downstream would notice it drift.
    rewrite(
      "bun.lock",
      new RegExp(
        `("name":\\s*"@fitzzero/quickdraw-(?:core|lint|skills|codemod)",\\s*\\n\\s*"version":\\s*")${quoted}(")`,
        "g",
      ),
      `$1${next}$2`,
      4,
    );

    // An entry left under `## [Unreleased]` is what this release ships.
    const changelog = fs.readFileSync("CHANGELOG.md", "utf8");
    if (/^## \[Unreleased\][ \t]*$/m.test(changelog)) {
      rewrite("CHANGELOG.md", /^## \[Unreleased\][ \t]*$/gm, `## [${next}] - ${isoDate}`, 1);
    }

    console.error(`auto-release: wrote ${next} into ${written.join(", ")}`);
  ' "$version" "$next" "$date_iso" || fail "could not write the bump"
fi

printf 'action=bump\nversion=%s\nprevious=%s\nanchor=%s\nchanged=%s\n' \
  "$next" "$version" "$anchor" "$changed_count"
