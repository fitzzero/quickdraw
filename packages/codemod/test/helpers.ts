// Shared by the codemod's tests: copies of the fixture app to run the codemod
// on (under .test-output, inside this package, so the copies resolve
// @fitzzero/quickdraw-core, zod and react through this package's
// node_modules), the files of a tree, and which lines a review marker covers.

import { spawnSync } from "node:child_process";
import {
  cpSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
} from "node:fs";
import { createRequire } from "node:module";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { Node, Project } from "ts-morph";
import { MARKER } from "../src/markers";

/** The 4.1 fixture app, its expected output, and where the copies go. */
export const FIXTURE = fileURLToPath(new URL("fixtures/v4-app", import.meta.url));
export const EXPECTED = fileURLToPath(new URL("fixtures/v4-app.expected", import.meta.url));
export const PACKAGE = fileURLToPath(new URL("..", import.meta.url));
export const REPO = join(PACKAGE, "..", "..");
const OUTPUT = join(PACKAGE, ".test-output");

let copies = 0;

/** A fresh copy of the fixture app; removed again by `removeCopies`. */
export function copyFixture(label: string): string {
  copies += 1;
  const target = join(OUTPUT, `${label}-${String(process.pid)}-${String(copies)}`);
  rmSync(target, { recursive: true, force: true });
  mkdirSync(OUTPUT, { recursive: true });
  cpSync(FIXTURE, target, { recursive: true });
  return target;
}

/** Removes this process's copies. */
export function removeCopies(): void {
  for (const entry of readdirSync(OUTPUT, { withFileTypes: true })) {
    if (entry.isDirectory() && entry.name.includes(`-${String(process.pid)}-`)) {
      rmSync(join(OUTPUT, entry.name), { recursive: true, force: true });
    }
  }
}

/** Every file under `root` (relative, forward slashes) and its text, sorted by path. */
export function readTree(root: string): Map<string, string> {
  const files = new Map<string, string>();
  const walk = (dir: string): void => {
    for (const name of readdirSync(dir).toSorted()) {
      const path = join(dir, name);
      if (statSync(path).isDirectory()) {
        walk(path);
      } else {
        files.set(relative(root, path).split("\\").join("/"), readFileSync(path, "utf8"));
      }
    }
  };
  walk(root);
  return files;
}

const COMMENT_LINE = /^\s*(?:\/\/|\/\*|\*)/u;

/**
 * The 1-based lines each review marker covers in a file: the marker's own
 * line and the whole construct below it (the statement, member, property or
 * declaration that starts on the first line after the marker that is not a
 * comment).
 */
export function coveredLines(fileName: string, text: string): Set<number> {
  const covered = new Set<number>();
  const lines = text.split("\n");
  const project = new Project({ useInMemoryFileSystem: true });
  const file = project.createSourceFile(fileName.endsWith(".tsx") ? "file.tsx" : "file.ts", text);
  const offsets: number[] = [];
  let offset = 0;
  for (const line of lines) {
    offsets.push(offset);
    offset += line.length + 1;
  }
  lines.forEach((content, index) => {
    if (!content.includes(MARKER)) {
      return;
    }
    covered.add(index + 1);
    let next = index + 1;
    while (
      next < lines.length &&
      (COMMENT_LINE.test(lines[next] ?? "") || (lines[next] ?? "").trim() === "")
    ) {
      next += 1;
    }
    const start =
      (offsets[next] ?? 0) + ((lines[next] ?? "").length - (lines[next] ?? "").trimStart().length);
    let node: Node | undefined = file.getDescendantAtPos(start);
    while (
      node?.getParent() !== undefined &&
      node.getParent()?.getStart() === start &&
      !Node.isSourceFile(node.getParent())
    ) {
      node = node.getParent();
    }
    if (node === undefined) {
      return;
    }
    for (let line = node.getStartLineNumber(); line <= node.getEndLineNumber(); line += 1) {
      covered.add(line);
    }
  });
  return covered;
}

/** One oxlint diagnostic: its rule (`quickdraw(no-v4-api)`), file and line. */
export interface LintDiagnostic {
  readonly rule: string;
  readonly file: string;
  readonly line: number;
}

interface OxlintReport {
  readonly diagnostics: readonly {
    readonly code?: string;
    readonly filename: string;
    readonly labels: readonly { readonly span: { readonly line: number } }[];
  }[];
}

/** Runs the repository's oxlint over `cwd` with the config there (`.oxlintrc.json` by default). */
export function lint(cwd: string, config = ".oxlintrc.json"): LintDiagnostic[] {
  const require = createRequire(join(REPO, "package.json"));
  const manifest =
    (require.resolve.paths("oxlint") ?? [])
      .map((dir) => join(dir, "oxlint", "package.json"))
      .find((path) => existsSync(path)) ?? "";
  const bin = (
    JSON.parse(readFileSync(manifest, "utf8")) as { bin: string | Record<string, string> }
  ).bin;
  const entry = join(manifest, "..", typeof bin === "string" ? bin : (bin.oxlint ?? ""));
  const result = spawnSync(process.execPath, [entry, "--format", "json", "--config", config, "."], {
    cwd,
    encoding: "utf8",
    maxBuffer: 1024 ** 3,
  });
  const report = JSON.parse(result.stdout) as OxlintReport;
  return report.diagnostics.map((diagnostic) => ({
    rule: diagnostic.code ?? "",
    file: diagnostic.filename.split("\\").join("/").replace(/^\.\//u, ""),
    line: diagnostic.labels[0]?.span.line ?? 0,
  }));
}
