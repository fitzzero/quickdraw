// What the codemod writes is 5.0 code: on the fixture app's output, the
// TypeScript compiler (against the built @fitzzero/quickdraw-core) and the
// 5.0 lint rules (@fitzzero/quickdraw-lint's base config) report problems
// only on what a review marker covers. The input, for contrast, is genuine
// 4.1 code: it typechecks against the published @fitzzero/quickdraw-core
// 4.1.0, and the 5.0 rules report it.

import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { ModuleKind, ModuleResolutionKind, Project, ScriptTarget, ts } from "ts-morph";
import { runCodemod } from "../src/index";
import { copyFixture, coveredLines, lint, PACKAGE, readTree, removeCopies, REPO } from "./helpers";

const CORE = join(REPO, "packages", "core");
const V4 = join(PACKAGE, "node_modules", "quickdraw-core-v4");

let root = "";

beforeAll(() => {
  root = copyFixture("output");
  runCodemod({ root });
});

afterAll(() => {
  removeCopies();
});

/** The diagnostics TypeScript reports for the app at `appRoot`, as `file:line message`. */
function typecheck(
  appRoot: string,
  core: Record<string, string[]>,
): { file: string; line: number; message: string }[] {
  const project = new Project({
    compilerOptions: {
      target: ScriptTarget.ES2022,
      module: ModuleKind.ESNext,
      moduleResolution: ModuleResolutionKind.Bundler,
      lib: ["lib.es2023.d.ts", "lib.dom.d.ts", "lib.dom.iterable.d.ts"],
      jsx: ts.JsxEmit.ReactJSX,
      strict: true,
      noUnusedLocals: true,
      noUnusedParameters: true,
      noUncheckedIndexedAccess: true,
      esModuleInterop: true,
      skipLibCheck: true,
      noEmit: true,
      types: ["node"],
      paths: {
        ...core,
        "@project/shared": [join(appRoot, "packages/shared/src/index.ts")],
        "@project/db": [join(appRoot, "packages/db/src/index.ts")],
        "quickdraw-test-prisma": [join(CORE, "test/prisma/generated/client.ts")],
      },
    },
  });
  project.addSourceFilesAtPaths([
    join(appRoot, "**/*.ts"),
    join(appRoot, "**/*.tsx"),
    `!${join(appRoot, "node_modules")}/**`,
  ]);
  return project
    .getPreEmitDiagnostics()
    .filter((diagnostic) => diagnostic.getSourceFile()?.getFilePath().startsWith(appRoot) === true)
    .map((diagnostic) => ({
      file: (diagnostic.getSourceFile()?.getFilePath() ?? "").slice(appRoot.length + 1),
      line: diagnostic.getLineNumber() ?? 0,
      message: ts.flattenDiagnosticMessageText(diagnostic.compilerObject.messageText, " "),
    }));
}

/** Diagnostics on lines no review marker covers (or that use todoSchema). */
function uncovered<T extends { file: string; line: number }>(
  diagnostics: readonly T[],
  files: ReadonlyMap<string, string>,
): T[] {
  const covered = new Map<string, Set<number>>();
  return diagnostics.filter((diagnostic) => {
    const text = files.get(diagnostic.file) ?? "";
    let lines = covered.get(diagnostic.file);
    if (lines === undefined) {
      lines = coveredLines(diagnostic.file, text);
      covered.set(diagnostic.file, lines);
    }
    return (
      !lines.has(diagnostic.line) &&
      !(text.split("\n")[diagnostic.line - 1] ?? "").includes("todoSchema")
    );
  });
}

describe("the output", () => {
  it("typechecks against the built 5.0 core, apart from what review markers cover", () => {
    const diagnostics = typecheck(root, {});
    expect(diagnostics.length).toBeGreaterThan(0);
    expect(uncovered(diagnostics, readTree(root))).toEqual([]);
  });

  it("passes the 5.0 lint rules, apart from what review markers cover", () => {
    const config = {
      extends: [join(REPO, "packages/lint/oxlint.base.jsonc")],
      plugins: ["typescript", "import", "react", "nextjs", "jsx_a11y"],
      ignorePatterns: ["**/node_modules/**"],
    };
    writeFileSync(join(root, ".oxlintrc.json"), JSON.stringify(config));
    const quickdraw = lint(root).filter((diagnostic) => diagnostic.rule.startsWith("quickdraw("));
    expect(quickdraw.length).toBeGreaterThan(0);
    expect(uncovered(quickdraw, readTree(root))).toEqual([]);
  });
});

describe("the fixture app", () => {
  it("is 4.1 code: it typechecks against the published @fitzzero/quickdraw-core 4.1.0", () => {
    const appRoot = copyFixture("input");
    const v4 = {
      "@fitzzero/quickdraw-core": [join(V4, "dist/shared/index.d.ts")],
      "@fitzzero/quickdraw-core/server": [join(V4, "dist/server/index.d.ts")],
      "@fitzzero/quickdraw-core/client": [join(V4, "dist/client/index.d.ts")],
      // 4.1 apps are on Zod 3, and so are 4.1's own types
      zod: [join(PACKAGE, "node_modules", "zod3")],
    };
    expect(typecheck(appRoot, v4)).toEqual([]);
  });
});
