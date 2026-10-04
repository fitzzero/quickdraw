// The README's code examples, and the quickdraw-new-service skill's, are
// copies of the files beside this test, which `bun run typecheck` compiles
// (see examples.ts). This checks every copy, and that no TypeScript block
// in them is anything but a copy.

import { existsSync, readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  checkDocument,
  DOCUMENTS,
  documentPath,
  parseDocument,
  sourceOf,
  syncDocument,
} from "./examples";
import { fromPackageDirectory, PACKAGE_FILES, packageFileText } from "./packageFiles";

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
    const source = sourceOf("apps/api/src/db.ts", undefined) ?? "";
    const synced = syncDocument(document);
    expect(synced).toContain(`\`\`\`ts\n${source}\n\`\`\``);
    // The unmarked block moves down by the source's lines, less the stale one.
    const unmarked = 9 + source.split("\n").length - 1;
    expect(checkDocument("doc.md", synced)).toEqual([
      `doc.md: the tsx block on line ${String(unmarked)} is not a copy of an example`,
    ]);
  });

  it("copy a region of a file without its markers, and nothing for a missing one", () => {
    const region = sourceOf("apps/api/src/jobs/overdue.ts", "run") ?? "";
    expect(region.startsWith("export async function markStale(")).toBe(true);
    expect(region).not.toContain("#region");
    expect(sourceOf("apps/api/src/jobs/overdue.ts", undefined)).not.toContain("#region");
    expect(sourceOf("apps/api/src/missing.ts", undefined)).toBeUndefined();
    expect(sourceOf("apps/api/src/db.ts", "nowhere")).toBeUndefined();
  });
});

describe("the files the packages ship beside their code", () => {
  it.each(PACKAGE_FILES.map((file) => [file.path, file] as const))(
    "%s is a copy of the repo's (run bun run readme:sync in packages/core)",
    (path, file) => {
      expect(existsSync(documentPath(path))).toBe(true);
      expect(readFileSync(documentPath(path), "utf8")).toBe(packageFileText(file));
    },
  );

  it("make the README's relative links relative to the package directory", () => {
    expect(
      fromPackageDirectory(
        "[a](docs/x.md) [b](packages/lint) [c](https://x.dev/y) [d](#install) [e](/abs) [f](mailto:a@b.c)",
      ),
    ).toBe(
      "[a](../../docs/x.md) [b](../../packages/lint) [c](https://x.dev/y) [d](#install) [e](/abs) [f](mailto:a@b.c)",
    );
  });
});
