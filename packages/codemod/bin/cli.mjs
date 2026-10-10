#!/usr/bin/env node
// `quickdraw-codemod v5 <repo>`: moves a quickdraw 4.x app to 5.0 and writes
// quickdraw-migration-report.md (see README.md). The code is built to dist/.
// On a large app (or with --heap) it starts again in a Node with a larger
// heap, passing this file on (src/heap.ts).
import { fileURLToPath } from "node:url";
import { start } from "../dist/cli.js";

process.exitCode = start(process.argv.slice(2), fileURLToPath(import.meta.url));
