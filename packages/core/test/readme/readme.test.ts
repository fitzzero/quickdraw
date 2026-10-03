// The README's code examples, and the quickdraw-new-service skill's, are
// copies of the files beside this test, which `bun run typecheck` compiles
// (see examples.ts). This checks every copy, and that no TypeScript block
// in them is anything but a copy.

import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  checkDocument,
  DOCUMENTS,
  documentPath,
  parseDocument,
  sourceOf,
  syncDocument,
} from "./examples";

describe.each(DOCUMENTS)("the examples of %s", (document) => {
  const text = readFileSync(documentPath(document), "utf8");

  it("are copies of the compiled examples", () => {
    expect(checkDocument(document, text)).toEqual([]);
  });

  it("are there", () => {
    expect(parseDocument(text).examples.length).toBeGreaterThan(0);
  });
});

describe("example copies", () => {
  const document = [
    "Text.",
    "",
    "<!-- example: apps/api/src/db.ts -->",
    "",
    "```ts",
    "stale",
    "```",
    "",
    "```tsx",
    "const unmarked = 1;",
    "```",
    "",
    "```bash",
    "bun add @fitzzero/quickdraw-core",
    "```",
    "",
  ].join("\n");

  it("report a stale copy and a TypeScript block without a source", () => {
    expect(checkDocument("doc.md", document)).toEqual([
      "doc.md: the tsx block on line 9 is not a copy of an example",
      "doc.md line 5 (apps/api/src/db.ts) is not a copy of its source: run bun run readme:sync in packages/core",
    ]);
  });

  it("are rewritten from their sources by readme:sync", () => {
    const synced = syncDocument(document);
    expect(synced).toContain(
      `\`\`\`ts\n${sourceOf("apps/api/src/db.ts", undefined) ?? ""}\n\`\`\``,
    );
    expect(checkDocument("doc.md", synced)).toEqual([
      "doc.md: the tsx block on line 15 is not a copy of an example",
    ]);
  });

  it("copy one region of a file without its markers", () => {
    expect(sourceOf("apps/api/src/missing.ts", undefined)).toBeUndefined();
    expect(sourceOf("apps/api/src/db.ts", "nowhere")).toBeUndefined();
  });
});
