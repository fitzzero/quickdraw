#!/usr/bin/env node
// The `quickdraw-lint` command. One subcommand so far: `baseline`.

import { main as baseline } from "./baseline.mjs";

const USAGE = `Usage: quickdraw-lint <command> [options]

Commands:
  baseline   record the quickdraw rules' current violations, so the rules
             report only new ones (quickdraw-lint baseline --help)
`;

const [command, ...args] = process.argv.slice(2);

if (command === "baseline") {
  process.exitCode = baseline(args);
} else if (command === undefined || command === "--help" || command === "-h") {
  process.stdout.write(USAGE);
} else {
  process.stderr.write(`quickdraw-lint: unknown command "${command}"\n\n${USAGE}`);
  process.exitCode = 2;
}
