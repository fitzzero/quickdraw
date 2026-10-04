// The `quickdraw-protocol` command (`bun run protocol:sync` and
// `protocol:check` in packages/core): writes or checks `docs/protocol-v5.md`.
// The work is in `protocol.ts`.

import process from "node:process";
import { main } from "./protocol";

process.exitCode = main(process.argv.slice(2), {
  out: (text) => {
    process.stdout.write(text);
  },
  err: (text) => {
    process.stderr.write(text);
  },
});
