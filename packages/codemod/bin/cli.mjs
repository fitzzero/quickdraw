#!/usr/bin/env node
// `quickdraw-codemod v5 <repo>`: moves a quickdraw 4.x app to 5.0 and writes
// quickdraw-migration-report.md (see README.md). The code is built to dist/.
import { main } from "../dist/cli.js";

process.exitCode = main(process.argv.slice(2));
