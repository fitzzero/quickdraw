#!/usr/bin/env bash
# The setup command of the Conveyor image bake: the Conveyor project's Setup
# Command (Project Settings, Cloud, Compute, Setup) is
# `bash scripts/bake-setup.sh`.
#
# Conveyor runs it once per bake, from the root of a fresh checkout of `dev`,
# as the `conveyor` user, and keeps the result in the image every card's pod
# boots from. A pod then fetches its card's branch on top, so what runs here
# is what a pod does not repeat at boot: the install, the generated Prisma
# clients and a first build.
#
# The bake image brings Node, bun and git. This repository needs nothing else
# installed, and its tests run on PGlite, so the bake needs no database and
# the project declares no sidecar service.
#
# It is a script, not text in the settings field, so that what the image holds
# is versioned and reviewed here. On `dev`, a change under scripts/, to a
# package.json or to bun.lock starts a new bake.
set -euo pipefail

cd "$(dirname "$0")/.."

echo "bake-setup: node $(node --version), bun $(bun --version)"

# The install CI makes: the lockfile as committed, no lifecycle scripts. The
# root `prepare` script is skipped with them: the .claude/ links it makes are
# committed, and its husky hooks are for a contributor's checkout.
bun install --frozen-lockfile --ignore-scripts

# The gitignored Prisma clients (core's test client, the v5 bench app's) and
# every package's dist/. turbo records both in its cache, so a pod's first
# typecheck, build or test starts from them.
./node_modules/.bin/turbo run db:generate build

echo "bake-setup: done"
