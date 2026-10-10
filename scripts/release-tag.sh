#!/usr/bin/env bash
# Prints the git tag that releases <package> at <version>, after checking the
# release is ready: the working tree is clean, <version> is a semantic version,
# and it equals the version in packages/<package>/package.json.
#
# It never creates or pushes the tag, and a tag pushed by hand publishes
# nothing: a release is a merge to main, which .github/workflows/publish.yml
# publishes and tags. This is the pre-flight check for one, and the name of the
# tag it will leave behind (see docs/releasing.md).
#
# Usage: scripts/release-tag.sh <package> <version>
#   <package>  core | lint | skills | codemod (its directory under packages/)
#   <version>  e.g. 5.0.0-alpha.1 or 5.0.0
#
# The tag goes to stdout on its own, so `tag="$(scripts/release-tag.sh ...)"`
# works; everything else goes to stderr.
set -euo pipefail
export LC_ALL=C

fail() {
  echo "release-tag: $*" >&2
  exit 1
}

if [ "$#" -ne 2 ]; then
  echo "usage: scripts/release-tag.sh <core|lint|skills|codemod> <version>" >&2
  exit 2
fi
pkg="$1"
version="$2"

case "$pkg" in
  core | lint | skills | codemod) ;;
  *) fail "unknown package '$pkg' (expected core, lint, skills or codemod)" ;;
esac

# Semantic Versioning 2.0.0, prerelease allowed. Build metadata (+...) is
# refused: npm drops it, so the published version would not match the tag.
# .github/workflows/publish.yml uses the same pattern.
semver='^(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)(-(0|[1-9][0-9]*|[0-9]*[A-Za-z-][0-9A-Za-z-]*)(\.(0|[1-9][0-9]*|[0-9]*[A-Za-z-][0-9A-Za-z-]*))*)?$'
if ! [[ "$version" =~ $semver ]]; then
  fail "'$version' is not a semantic version (MAJOR.MINOR.PATCH with an optional -prerelease)"
fi

root="$(git rev-parse --show-toplevel 2> /dev/null)" || fail "not inside a git repository"

if [ -n "$(git -C "$root" status --porcelain)" ]; then
  fail "the working tree is not clean; commit or stash your changes first (git status)"
fi

manifest="$root/packages/$pkg/package.json"
[ -f "$manifest" ] || fail "packages/$pkg/package.json does not exist"
fields="$(node -e '
  const p = require(process.argv[1]);
  console.log(p.name, p.version, p.private === true);
' "$manifest")" || fail "could not read packages/$pkg/package.json"
read -r name manifest_version private <<< "$fields"

if [ "$manifest_version" != "$version" ]; then
  fail "packages/$pkg/package.json is at version $manifest_version, not $version"
fi
if [ "$private" = true ]; then
  fail "$name is private and cannot be published"
fi

tag="$pkg-v$version"
echo "$tag"
cat >&2 << EOF
release-tag: $name $version is ready to publish, and will be tagged $tag.
A push of this commit to main publishes it. To publish it from another ref:
  gh workflow run publish.yml --ref <ref> -f package=$pkg -f version=$version
EOF
