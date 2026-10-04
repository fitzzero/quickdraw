#!/usr/bin/env node
// The `quickdraw-lint` command: `baseline` records what the rules report now,
// `check` lints and reports only what the baseline does not record.

import { main as baseline } from "./baseline.mjs";
import { main as check } from "./check.mjs";

const USAGE = `Usage: quickdraw-lint <command> [options]

Commands:
  baseline   record every rule's current violations, so lint reports only
             new ones (quickdraw-lint baseline --help)
  check      run oxlint and report only the violations the baseline does not
             record, for every rule (quickdraw-lint check --help)
`;

const [command, ...args] = process.argv.slice(2);

if (command === "baseline") {
  process.exitCode = baseline(args);
} else if (command === "check") {
  process.exitCode = check(args);
} else if (command === undefined || command === "--help" || command === "-h") {
  process.stdout.write(USAGE);
} else {
  process.stderr.write(`quickdraw-lint: unknown command "${command}"\n\n${USAGE}`);
  process.exitCode = 2;
}
