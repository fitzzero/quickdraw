// The ts-morph project over the app's sources. The codemod reads syntax and
// follows relative imports; where it asks the type checker (a DTO's keys, a
// payload's `id`), the shared package resolves by name to its sources.

import { join } from "node:path";
import {
  IndentationText,
  ModuleKind,
  ModuleResolutionKind,
  Project,
  QuoteKind,
  ScriptTarget,
  ts,
  type SourceFile,
} from "ts-morph";
import type { Layout } from "./layout";

const SKIPPED = ["node_modules", "dist", ".next", "generated", "build", "coverage"];

/** A project holding the shared, api and web sources of `layout`, and its other packages that use quickdraw. */
export function loadProject(layout: Layout): Project {
  const project = new Project({
    compilerOptions: {
      target: ScriptTarget.ES2022,
      module: ModuleKind.ESNext,
      moduleResolution: ModuleResolutionKind.Bundler,
      jsx: ts.JsxEmit.Preserve,
      strict: true,
      skipLibCheck: true,
      noEmit: true,
      allowImportingTsExtensions: true,
      paths: { [layout.shared.name]: [join(layout.shared.src, "index.ts")] },
    },
    skipAddingFilesFromTsConfig: true,
    manipulationSettings: {
      quoteKind: QuoteKind.Double,
      indentationText: IndentationText.TwoSpaces,
      useTrailingCommas: true,
    },
  });
  const sources = [layout.shared.src, layout.api.src, layout.web?.src, ...layout.others].filter(
    (dir): dir is string => dir !== undefined,
  );
  const globs = sources.flatMap((dir) => [join(dir, "**/*.ts"), join(dir, "**/*.tsx")]);
  const exclusions = SKIPPED.map((name) => `!**/${name}/**`);
  project.addSourceFilesAtPaths([...globs, ...exclusions, "!**/*.d.ts"]);
  return project;
}

/** Whether `file` lies under directory `dir`. */
export function isUnder(file: SourceFile | string, dir: string): boolean {
  const path = typeof file === "string" ? file : file.getFilePath();
  return path.startsWith(`${dir}/`);
}

const TEST_CODE = /(?:^|\/)(?:__tests__|testing)\/|\.(?:test|spec)\.tsx?$/u;

/**
 * Whether `path` (relative to the repository root, forward slashes) is test
 * code: a file under a `__tests__` or `testing` directory, or a `*.test.ts(x)`
 * or `*.spec.ts(x)` file. The codemod reads no service from test code, so a
 * test's subclass of a service neither becomes a service nor hides the real
 * one; it still rewrites test code's uses of the services.
 */
export function isTestFile(path: string): boolean {
  return TEST_CODE.test(path);
}
