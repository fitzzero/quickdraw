#!/usr/bin/env bash
# PreToolUse hook: blocks bare `bun <script>` commands that should use `bun run <script>`
# Bare commands like `bun test` and `bun build` invoke bun's built-in tools (bun test
# runner, Bun.build) instead of the package.json scripts (vitest, tsup, oxlint, tsgo).

set -euo pipefail

INPUT=$(cat)
COMMAND=$(echo "$INPUT" | jq -r '.tool_input.command // empty')

if [ -z "$COMMAND" ]; then
  exit 0
fi

# Package.json script names that bare bun commands would shadow or bypass
SCRIPTS="dev|build|typecheck|lint|lint:fix|format|format:check|test|test:watch|test:coverage"

# Match `bun <script>` anywhere in the command, with optional trailing args
# but NOT `bun run <script>`, `bun x <script>`, `bunx`, `bun install`, etc.
if echo "$COMMAND" | grep -qP '(?<!\w)bun\s+(?!run\b|x\b|install\b|add\b|remove\b|update\b|link\b|unlink\b|pm\b|init\b|create\b|upgrade\b|completions\b|repl\b|exec\b|--)('"$SCRIPTS"')(\s|$|;|&|\|)'; then
  MATCHED=$(echo "$COMMAND" | grep -oP '(?<!\w)bun\s+('"$SCRIPTS"')(\s|$|;|&|\|)' | head -1 | sed 's/[;&| ]*$//')
  echo "BLOCKED: Use 'bun run <script>' instead of '$MATCHED'."
  echo "Bare bun commands invoke bun built-ins, not the package.json scripts (vitest, tsup, oxlint, tsgo)."
  exit 2
fi

exit 0
