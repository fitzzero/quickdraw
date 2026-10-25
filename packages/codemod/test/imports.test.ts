// The import cleanup every file the codemod writes gets (tidyImports): an
// import a name uses anywhere outside the imports stays, a destructuring
// default's included, and one only a property takes (a destructured key, a
// member name) goes, as does one nothing uses; the blank line under a
// directive or a header comment stays when the first import goes. And an
// import a transform adds (ensureImport) goes after the file's imports,
// never inside a comment above them.

import { describe, expect, it } from "vitest";
import { Project, type SourceFile } from "ts-morph";
import { ensureImport, tidyImports } from "../src/imports";

/** A file of `text`, in a project of its own. */
function fileOf(text: string): SourceFile {
  return new Project({ useInMemoryFileSystem: true }).createSourceFile("file.ts", text);
}

/** `text` as tidyImports leaves it. */
function tidied(text: string): string {
  const file = fileOf(text);
  tidyImports(file);
  return file.getFullText();
}

const HEADER =
  "// The writers a service hands its client to: the first gets the\n// service's own, and the second a transaction's.\n\n";

const LIMIT = 'import { LIMIT } from "./limits";\n';

describe("tidyImports", () => {
  it.each([
    ["an object pattern's", "export const { a = LIMIT } = {} as { a?: number };\n"],
    ["an array pattern's", "export const [b = LIMIT] = [] as number[];\n"],
    [
      "a renamed parameter pattern's",
      "export function pageOf({ c: d = LIMIT }: { c?: number }): number {\n  return d;\n}\n",
    ],
    [
      "a for...of pattern's",
      "export function sum(rows: { e?: number }[]): number {\n  let total = 0;\n  for (const { e = LIMIT } of rows) {\n    total += e;\n  }\n  return total;\n}\n",
    ],
  ])("keeps an import used only as %s default", (_form, code) => {
    expect(tidied(LIMIT + code)).toBe(LIMIT + code);
  });

  it("removes an import used only as a destructured key, which names a property", () => {
    const code = "export const { LIMIT: e } = {} as { LIMIT?: number };\n";
    expect(tidied(LIMIT + code)).toBe(code);
  });

  it("removes an import nothing uses", () => {
    const code = "export const page = 1;\n";
    expect(tidied(LIMIT + code)).toBe(code);
  });

  it.each([
    ["a directive", '"use client";\n\n'],
    ["a header comment", HEADER],
  ])("keeps the blank line under %s when it removes the first import", (_form, opening) => {
    const code =
      'import { useService } from "./hooks";\nimport { Button } from "./ui";\n\nexport const view = Button;\n';
    expect(tidied(opening + code)).toBe(
      `${opening}import { Button } from "./ui";\n\nexport const view = Button;\n`,
    );
  });
});

describe("ensureImport", () => {
  it("adds an import after the file's imports, never inside the comment above them", () => {
    const file = fileOf(
      `${HEADER}import type { PrismaClient } from "./db";\n\nexport type Db = PrismaClient;\n`,
    );
    ensureImport(file, "@fitzzero/quickdraw-core/prisma", "Tracked", { typeOnly: true });
    expect(file.getFullText()).toBe(
      `${HEADER}import type { PrismaClient } from "./db";\nimport type { Tracked } from "@fitzzero/quickdraw-core/prisma";\n\nexport type Db = PrismaClient;\n`,
    );
  });

  it("adds a name to the file's import of its module", () => {
    const file = fileOf('import type { Tracked } from "@fitzzero/quickdraw-core/prisma";\n');
    ensureImport(file, "@fitzzero/quickdraw-core/prisma", "TrackedTransaction", { typeOnly: true });
    expect(file.getFullText()).toBe(
      'import type { Tracked, TrackedTransaction } from "@fitzzero/quickdraw-core/prisma";\n',
    );
  });
});
