// The files every published package ships beside its code, kept as copies of
// the repo root's: `npm pack` adds a package directory's README.md and
// LICENSE whatever its `files` list says, so each package holds its own. The
// core package's README is the repo's README with its relative links made
// relative to `packages/core`, so they resolve there on GitHub and on npm
// (which resolves them against the repository's directory). `bun run
// readme:sync` (in packages/core) writes the copies; `readme.test.ts` checks
// them.

import { readFileSync } from "node:fs";
import { documentPath } from "./examples";

/** One copied file: where it goes, and the root file it copies. */
export interface PackageFile {
  /** From the repo root. */
  readonly path: string;
  readonly from: string;
  readonly transform?: (text: string) => string;
}

/** A Markdown document's relative links, made relative to a package directory two levels down. */
export function fromPackageDirectory(text: string): string {
  return text.replace(/\]\((?![a-z][\d+.a-z-]*:|#|\/)([^\s)]+)\)/giu, "](../../$1)");
}

export const PACKAGE_FILES: readonly PackageFile[] = [
  { path: "packages/core/README.md", from: "README.md", transform: fromPackageDirectory },
  { path: "packages/core/LICENSE", from: "LICENSE" },
  { path: "packages/lint/LICENSE", from: "LICENSE" },
  { path: "packages/skills/LICENSE", from: "LICENSE" },
  // the migration guide ships with the codemod that does most of it
  { path: "packages/codemod/MIGRATION.md", from: "MIGRATION.md", transform: fromPackageDirectory },
  { path: "packages/codemod/LICENSE", from: "LICENSE" },
];

/** What a package file must hold: its root file, transformed. */
export function packageFileText(file: PackageFile): string {
  const text = readFileSync(documentPath(file.from), "utf8");
  return file.transform === undefined ? text : file.transform(text);
}
