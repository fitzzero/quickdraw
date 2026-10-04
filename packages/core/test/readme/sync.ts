// `bun run readme:sync` (in packages/core): rewrites the code examples of the
// README, MIGRATION.md and the quickdraw-new-service skill from their sources
// (see examples.ts), then the copies of the README, the guide and the LICENSE
// the packages ship (see packageFiles.ts). Run it after changing an example,
// the README or the guide, then `bun run format`.

import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { DOCUMENTS, documentPath, syncDocument } from "./examples";
import { PACKAGE_FILES, packageFileText } from "./packageFiles";

for (const document of DOCUMENTS) {
  const path = documentPath(document);
  const text = readFileSync(path, "utf8");
  const synced = syncDocument(text);
  if (synced !== text) {
    writeFileSync(path, synced);
    process.stdout.write(`readme:sync: rewrote the examples of ${document}\n`);
  }
}

for (const file of PACKAGE_FILES) {
  const path = documentPath(file.path);
  const text = packageFileText(file);
  if (!existsSync(path) || readFileSync(path, "utf8") !== text) {
    writeFileSync(path, text);
    process.stdout.write(`readme:sync: wrote ${file.path} from ${file.from}\n`);
  }
}
