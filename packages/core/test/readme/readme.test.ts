// The README's code examples, the migration guide's and the
// quickdraw-new-service skill's are copies of the files beside this test,
// which `bun run typecheck` compiles (see examples.ts). This checks every
// copy, and that no TypeScript block in them is anything but a copy.

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
import { forPackage, GITHUB, PACKAGE_FILES, packageFileText, RELATIVE_LINK } from "./packageFiles";

describe.each(DOCUMENTS)("the examples of %s", (document) => {
  const text = readFileSync(documentPath(document), "utf8");

  it("are copies of the compiled examples", () => {
    expect(checkDocument(document, text)).toEqual([]);
  });

  it("are there", () => {
    expect(parseDocument(text).examples.length).toBeGreaterThan(0);
  });
});

describe("the new-service skill's server examples (finding F7.6)", () => {
  // The template's API compiles as an ES module with NodeNext resolution, where a relative
  // import without its `.js` is TS2835. This project compiles with bundler resolution, which
  // takes either: core's own sources, mapped here, are not NodeNext modules, so the rule is
  // checked on the copies instead.
  const skill = DOCUMENTS.find((document) => document.includes("quickdraw-new-service")) ?? "";
  const server = parseDocument(readFileSync(documentPath(skill), "utf8")).examples.filter(
    (example) => example.file.startsWith("apps/api/"),
  );

  it("name each relative import's file with .js, as NodeNext needs", () => {
    expect(server.length).toBeGreaterThan(0);
    const relative = server.flatMap((example) =>
      [...example.code.matchAll(/from "(\.{1,2}\/[^"]+)"/g)].map((match) => match[1] ?? ""),
    );
    expect(relative.length).toBeGreaterThan(0);
    expect(relative.filter((specifier) => !specifier.endsWith(".js"))).toEqual([]);
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

  it("copy a region inside a block without the marker's indentation", () => {
    const region =
      sourceOf("../../../codemod/test/guide-v4/apps/api/src/services/task.ts", "projection") ?? "";
    expect(region.startsWith("protected override toDto(task: Task): TaskDTO {")).toBe(true);
    expect(region.split("\n").at(-1)).toBe("}");
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

  it.each(["core", "lint", "skills", "codemod"])(
    "@fitzzero/quickdraw-%s's package.json names no workspace: range, which npm publish ships as it is",
    (name) => {
      const manifest = readFileSync(documentPath(`packages/${name}/package.json`), "utf8");
      expect(manifest).not.toContain("workspace:");
    },
  );

  it("keep a link into the package relative to it, and point every other at GitHub (finding F5.7)", () => {
    expect(
      forPackage("packages/core")(
        "[a](docs/clients.md#hooks) [b](packages/lint) [c](https://x.dev/y) [d](#install) [e](/abs) [f](mailto:a@b.c) [g](packages/core/CHANGELOG.md)",
      ),
    ).toBe(
      `[a](${GITHUB}/blob/main/docs/clients.md#hooks) [b](${GITHUB}/tree/main/packages/lint) [c](https://x.dev/y) [d](#install) [e](/abs) [f](mailto:a@b.c) [g](CHANGELOG.md)`,
    );
  });

  it.each(PACKAGE_FILES.filter((file) => file.path.endsWith(".md")).map((file) => file.path))(
    "%s has no relative link out of its package, which is all node_modules holds",
    (path) => {
      const text = readFileSync(documentPath(path), "utf8");
      const outward = [...text.matchAll(RELATIVE_LINK)]
        .map(([, target = ""]) => target)
        .filter((target) => target.startsWith("../") || target.startsWith("/"));
      expect(outward).toEqual([]);
    },
  );
});
