// Removing code by a text edit (removalEdit): a node on lines of its own
// goes with them and the comments right above it, and the blank lines
// around it stay one; a node sharing its line goes alone.

import { describe, expect, it } from "vitest";
import { Node, Project } from "ts-morph";
import { applyEdits, removalEdit } from "../src/text";

/** `text` without its first statement (at any depth) whose code starts with `code`. */
function without(text: string, code: string): string {
  const file = new Project({ useInMemoryFileSystem: true }).createSourceFile("file.ts", text);
  const node = file
    .getDescendants()
    .find((candidate) => Node.isStatement(candidate) && candidate.getText().startsWith(code));
  if (node === undefined) {
    throw new Error(`no statement starts with ${code}`);
  }
  return applyEdits(text, 0, [removalEdit(node)]);
}

describe("removalEdit", () => {
  it("takes a declaration's comments, and one of the blank lines around it", () => {
    expect(
      without("const a = 1;\n\n// what b does\nfunction b() {}\n\nconst c = 3;\n", "function b"),
    ).toBe("const a = 1;\n\nconst c = 3;\n");
    expect(without("/** b */\nexport function b() {}\n", "export function b")).toBe("");
  });

  it("leaves a comment a blank line sets apart, and no blank line at the end of the file", () => {
    expect(without("// the file\n\nfunction b() {}\n", "function b")).toBe("// the file\n");
    expect(without("const a = 1;\n\nfunction b() {}\n", "function b")).toBe("const a = 1;\n");
  });

  it("leaves no blank line at the start or the end of a block, and takes a trailing comment", () => {
    expect(without("function f() {\n  a();\n\n  b();\n}\n", "a();")).toBe(
      "function f() {\n  b();\n}\n",
    );
    expect(without("function f() {\n  a();\n\n  b(); // why\n}\n", "b();")).toBe(
      "function f() {\n  a();\n}\n",
    );
    expect(without("function f() {\n  a();\n  b();\n  c();\n}\n", "b();")).toBe(
      "function f() {\n  a();\n  c();\n}\n",
    );
  });

  it("removes only the node, with the spaces that set it apart, from a line it shares", () => {
    expect(without("a(); b();\n", "b();")).toBe("a();\n");
    expect(without("  a(); b();\n", "a();")).toBe("  b();\n");
  });
});
