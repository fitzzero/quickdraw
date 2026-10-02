#!/usr/bin/env bash
# Tests for scripts/release-tag.sh. Run from anywhere:
#   bash scripts/release-tag.test.sh
# Each case runs the script inside a throwaway git repository, isolated from
# the caller's git config (identity, hooks, signing).
set -euo pipefail

script="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/release-tag.sh"
tmp="$(mktemp -d)"
trap 'rm -rf "$tmp"' EXIT

export GIT_CONFIG_GLOBAL=/dev/null GIT_CONFIG_NOSYSTEM=1
export GIT_AUTHOR_NAME=test GIT_AUTHOR_EMAIL=test@example.com
export GIT_COMMITTER_NAME=test GIT_COMMITTER_EMAIL=test@example.com

failures=0
status=0
out=""
err=""

# run <dir> <args...>: runs release-tag.sh from <dir>, capturing the exit
# status, stdout and stderr.
run() {
  local dir="$1"
  shift
  status=0
  (cd "$dir" && bash "$script" "$@") > "$tmp/stdout" 2> "$tmp/stderr" || status=$?
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

# expect_tag <description> <tag>: the run succeeded and printed only <tag>.
expect_tag() {
  if [ "$status" -eq 0 ] && [ "$out" = "$2" ]; then report ok "$1"; else report fail "$1"; fi
}

# expect_refused <description> <stderr text>: the run failed, printed no tag,
# and said why.
expect_refused() {
  if [ "$status" -ne 0 ] && [ -z "$out" ] && [[ "$err" == *"$2"* ]]; then
    report ok "$1"
  else
    report fail "$1"
  fi
}

repo="$tmp/repo"
mkdir -p "$repo/packages/core" "$repo/packages/lint" "$repo/packages/skills"
echo '{ "name": "@test/core", "version": "5.0.0-alpha.1" }' > "$repo/packages/core/package.json"
echo '{ "name": "@test/lint", "version": "1.2.3" }' > "$repo/packages/lint/package.json"
echo '{ "name": "@test/skills", "version": "1.0.0", "private": true }' > "$repo/packages/skills/package.json"
git -C "$repo" init -q
git -C "$repo" add .
git -C "$repo" commit -q -m "initial"

# A good version.
run "$repo" core 5.0.0-alpha.1
expect_tag "a prerelease that matches package.json prints its tag" core-v5.0.0-alpha.1
run "$repo" lint 1.2.3
expect_tag "a release that matches package.json prints its tag" lint-v1.2.3
run "$repo/packages/core" core 5.0.0-alpha.1
expect_tag "it works from a subdirectory of the repository" core-v5.0.0-alpha.1
if [ -z "$(git -C "$repo" tag --list)" ]; then
  report ok "it creates no tag"
else
  report fail "it creates no tag"
fi

# A mismatched version.
run "$repo" core 5.0.0-alpha.2
expect_refused "a version that differs from package.json is refused" "is at version 5.0.0-alpha.1, not 5.0.0-alpha.2"
run "$repo" lint 1.2.4
expect_refused "a release that differs from package.json is refused" "is at version 1.2.3, not 1.2.4"

# A dirty tree.
echo '{ "name": "@test/core", "version": "5.0.0-alpha.1", "description": "edited" }' > "$repo/packages/core/package.json"
run "$repo" core 5.0.0-alpha.1
expect_refused "a modified tracked file is refused" "working tree is not clean"
git -C "$repo" checkout -q -- packages/core/package.json
touch "$repo/untracked.txt"
run "$repo" core 5.0.0-alpha.1
expect_refused "an untracked file is refused" "working tree is not clean"
rm "$repo/untracked.txt"
run "$repo" core 5.0.0-alpha.1
expect_tag "a clean tree is accepted again" core-v5.0.0-alpha.1

# Other refusals.
for bad in 5.0 v5.0.0 05.0.0 5.0.0-01 5.0.0- 5.0.0-alpha..1 5.0.0+build.7; do
  run "$repo" core "$bad"
  expect_refused "'$bad' is not accepted as a semantic version" "not a semantic version"
done
run "$repo" bench 1.0.0
expect_refused "an unknown package is refused" "unknown package 'bench'"
run "$repo" skills 1.0.0
expect_refused "a private package is refused" "is private"
run "$repo" core
expect_refused "a missing argument prints the usage" "usage:"

if [ "$failures" -gt 0 ]; then
  echo "$failures release-tag test(s) failed" >&2
  exit 1
fi
echo "All release-tag tests passed"
