// The import cleanup every file the codemod writes gets (tidyImports): an
// import a name uses anywhere outside the imports stays, a destructuring
// default's included, and one only a property takes (a destructured key, a
// member name) goes, as does one nothing uses.

import { describe, expect, it } from "vitest";
import { Project } from "ts-morph";
import { tidyImports } from "../src/imports";

/** `text` as tidyImports leaves it. */
function tidied(text: string): string {
  const file = new Project({ useInMemoryFileSystem: true }).createSourceFile("file.ts", text);
  tidyImports(file);
  return file.getFullText();
}

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
});
