#!/usr/bin/env node
// The `quickdraw-docs` command (bin in package.json): Markdown API docs from
// an app's contracts. The work is in `docs.ts`; `quickdraw-docs --help`
// prints the usage.

import process from "node:process";
import { main } from "./docs";

process.exitCode = await main(process.argv.slice(2), {
  out: (text) => {
    process.stdout.write(text);
  },
  err: (text) => {
    process.stderr.write(text);
  },
});
