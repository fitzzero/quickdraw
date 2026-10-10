#!/usr/bin/env bash
# Tests for scripts/auto-release.sh. Run from anywhere:
#   bash scripts/auto-release.test.sh
# Each case builds a throwaway repository in the shape this one publishes from
# (four manifests at one version, core's version.ts, bun.lock's workspace
# entries, a CHANGELOG), isolated from the caller's git config.
set -euo pipefail
export LC_ALL=C

script="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/auto-release.sh"
tmp="$(mktemp -d)"
trap 'rm -rf "$tmp"' EXIT

export GIT_CONFIG_GLOBAL=/dev/null GIT_CONFIG_NOSYSTEM=1
export GIT_AUTHOR_NAME=test GIT_AUTHOR_EMAIL=test@example.com
export GIT_COMMITTER_NAME=test GIT_COMMITTER_EMAIL=test@example.com

failures=0
status=0
out=""
err=""
repo=""

# run <args...>: runs auto-release.sh in $repo, capturing status, stdout, stderr.
run() {
  status=0
  (cd "$repo" && bash "$script" "$@") > "$tmp/stdout" 2> "$tmp/stderr" || status=$?
  out="$(cat "$tmp/stdout")"
  err="$(cat "$tmp/stderr")"
}

report() {
  if [ "$1" = ok ]; then
    echo "ok   - $2"
  else
    echo "FAIL - $2"
    echo "       exit $status, stdout: '$out'"
    echo "       stderr: '$err'"
    failures=$((failures + 1))
  fi
}

# expect_plan <description> <key=value>...: the run succeeded and printed each
# of these lines.
expect_plan() {
  local description="$1"
  shift
  local missing=""
  for pair in "$@"; do
    printf '%s\n' "$out" | grep -qxF "$pair" || missing="$missing $pair"
  done
  if [ "$status" -eq 0 ] && [ -z "$missing" ]; then
    report ok "$description"
  else
    report fail "$description (missing:$missing)"
  fi
}

# expect_refused <description> <stderr text>: the run failed and said why.
expect_refused() {
  if [ "$status" -ne 0 ] && [[ "$err" == *"$2"* ]]; then report ok "$1"; else report fail "$1"; fi
}

# expect_file <description> <path> <text>: <path> in $repo contains <text>.
expect_file() {
  if grep -qF "$3" "$repo/$2" 2> /dev/null; then report ok "$1"; else report fail "$1 ($2 lacks '$3')"; fi
}

# seed <name> <version>: a repository at <version>, committed, $repo set to it.
seed() {
  repo="$tmp/$1"
  local version="$2"
  mkdir -p "$repo"/packages/{core/src,lint/plugin,skills/rules,codemod/src}
  for pkg in core lint skills codemod; do
    cat > "$repo/packages/$pkg/package.json" << JSON
{
  "name": "@fitzzero/quickdraw-$pkg",
  "version": "$version",
  "type": "module"
}
JSON
  done
  printf 'export const QUICKDRAW_VERSION = "%s";\n' "$version" > "$repo/packages/core/src/version.ts"
  {
    echo '{'
    echo '  "lockfileVersion": 1,'
    echo '  "workspaces": {'
    for pkg in core lint skills codemod; do
      echo "    \"packages/$pkg\": {"
      echo "      \"name\": \"@fitzzero/quickdraw-$pkg\","
      echo "      \"version\": \"$version\","
      echo '    },'
    done
    echo '  },'
    echo '}'
  } > "$repo/bun.lock"
  printf '# Changelog\n\n## [Unreleased]\n\n- something\n' > "$repo/CHANGELOG.md"
  echo 'export const made = 1;' > "$repo/packages/core/src/index.ts"
  echo '# readme' > "$repo/README.md"
  git -C "$repo" init -q
  git -C "$repo" add -A
  git -C "$repo" commit -qm "seed $version"
}

# commit <path> <text>: writes the file and commits it.
commit() {
  mkdir -p "$(dirname "$repo/$1")"
  printf '%s\n' "$2" > "$repo/$1"
  git -C "$repo" add -A
  git -C "$repo" commit -qm "change $1"
}

# --- the version in the repository is not on npm: publish it -----------------

seed unpublished 5.0.1
run
expect_plan "an unpublished version is the release" action=publish version=5.0.1 previous=5.0.1

# --- it is on npm, with no tag to compare against: seed the tag --------------

seed unanchored 5.0.1
run --published
expect_plan "a published version with no release tag releases nothing" action=none version=5.0.1 anchor=

# --- it is on npm and tagged ------------------------------------------------

seed quiet 5.0.1
git -C "$repo" tag core-v5.0.1
commit packages/core/src/index.test.ts "// a test"
commit packages/core/README.md "# docs"
commit bench/run.ts "// not published"
run --published
expect_plan "tests, docs and unpublished code release nothing" action=none version=5.0.1 anchor=core-v5.0.1 changed=0

seed bumped 5.0.1
git -C "$repo" tag core-v5.0.1
commit packages/core/src/feature.ts "export const feature = 1;"
run --published
expect_plan "shipped source bumps the patch" action=bump version=5.0.2 previous=5.0.1 anchor=core-v5.0.1 changed=1

seed manifest 5.0.1
git -C "$repo" tag core-v5.0.1
commit packages/lint/package.json '{ "name": "@fitzzero/quickdraw-lint", "version": "5.0.1", "dependencies": {} }'
run --published
expect_plan "a manifest is shipped source" action=bump version=5.0.2

# @fitzzero/quickdraw-skills ships Markdown, so .md counts there and nowhere else.
seed skills 5.0.1
git -C "$repo" tag core-v5.0.1
commit packages/skills/rules/quickdraw-access.md "# a rule"
run --published
expect_plan "the skills package's Markdown is shipped source" action=bump version=5.0.2 changed=1

# --- what it refuses -------------------------------------------------------

seed split 5.0.1
printf '{\n  "name": "@fitzzero/quickdraw-lint",\n  "version": "5.0.2"\n}\n' > "$repo/packages/lint/package.json"
run
expect_refused "four versions that disagree" "share one version"

seed broken 5.0.1
printf '{\n  "name": "@fitzzero/quickdraw-core"\n}\n' > "$repo/packages/core/package.json"
run
expect_refused "a manifest with no version" "has no version"

seed prerelease 5.1.0-rc.1
git -C "$repo" tag core-v5.1.0-rc.1
commit packages/core/src/feature.ts "export const feature = 1;"
run --published
expect_plan "a published prerelease is never bumped by machine" action=none version=5.1.0-rc.1

# --- --write ---------------------------------------------------------------

seed written 5.0.1
git -C "$repo" tag core-v5.0.1
commit packages/core/src/feature.ts "export const feature = 1;"
run --published --write --date 2026-10-10
expect_plan "--write still prints the plan" action=bump version=5.0.2
expect_file "--write bumps core's manifest" packages/core/package.json '"version": "5.0.2"'
expect_file "--write bumps the codemod's manifest" packages/codemod/package.json '"version": "5.0.2"'
expect_file "--write bumps QUICKDRAW_VERSION" packages/core/src/version.ts 'QUICKDRAW_VERSION = "5.0.2"'
expect_file "--write dates the CHANGELOG's Unreleased heading" CHANGELOG.md '## [5.0.2] - 2026-10-10'
if [ "$(grep -c '"version": "5.0.2"' "$repo/bun.lock")" = 4 ]; then
  report ok "--write bumps all four bun.lock entries"
else
  report fail "--write bumps all four bun.lock entries"
fi

seed quiet-write 5.0.1
git -C "$repo" tag core-v5.0.1
run --published --write
expect_plan "--write with nothing to release writes nothing" action=none
expect_file "the manifest is untouched" packages/core/package.json '"version": "5.0.1"'
expect_file "the CHANGELOG heading is untouched" CHANGELOG.md '## [Unreleased]'

if [ "$failures" -eq 0 ]; then
  echo "auto-release.test: all cases passed"
else
  echo "auto-release.test: $failures case(s) failed" >&2
  exit 1
fi
