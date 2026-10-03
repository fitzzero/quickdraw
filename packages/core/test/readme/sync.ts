// `bun run readme:sync` (in packages/core): rewrites the code examples of the
// README and the quickdraw-new-service skill from their sources in this
// directory (see examples.ts). Run it after changing an example, then
// `bun run format`.

import { readFileSync, writeFileSync } from "node:fs";
import { DOCUMENTS, documentPath, syncDocument } from "./examples";

for (const document of DOCUMENTS) {
  const path = documentPath(document);
  const text = readFileSync(path, "utf8");
  const synced = syncDocument(text);
  if (synced !== text) {
    writeFileSync(path, synced);
    process.stdout.write(`readme:sync: rewrote the examples of ${document}\n`);
  }
}
