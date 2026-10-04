// The files every published package ships beside its code, kept as copies of
// the repo root's: `npm pack` adds a package directory's README.md and
// LICENSE whatever its `files` list says, so each package holds its own. The
// core package's README is the repo's README with its relative links made
// relative to `packages/core`, so they resolve there on GitHub and on npm
// (which resolves them against the repository's directory). The codemod
// ships the migration guide and the upgrade procedure, which are read from
// `node_modules` where a relative link leads nowhere: their links point at
// the repository on GitHub instead. `bun run readme:sync` (in packages/core)
// writes the copies; `readme.test.ts` checks them.

import { existsSync, readFileSync, statSync } from "node:fs";
import { documentPath } from "./examples";

/** One copied file: where it goes, and the root file it copies. */
export interface PackageFile {
  /** From the repo root. */
  readonly path: string;
  readonly from: string;
  readonly transform?: (text: string) => string;
}

/** A Markdown document's relative links (not anchors, not URLs). */
const RELATIVE_LINK = /\]\((?![a-z][\d+.a-z-]*:|#|\/)([^\s)#]+)(#[^\s)]*)?\)/giu;

/** A Markdown document's relative links, made relative to a package directory two levels down. */
export function fromPackageDirectory(text: string): string {
  return text.replace(RELATIVE_LINK, (_, path: string, anchor = "") => `](../../${path}${anchor})`);
}

/** The repository's files on GitHub, on the branch the guide describes. */
export const GITHUB = "https://github.com/fitzzero/quickdraw";
const BRANCH = "dev";

/** A Markdown document's relative links, made absolute links to the repository on GitHub. */
export function toGitHub(text: string): string {
  return text.replace(RELATIVE_LINK, (_, path: string, anchor = "") => {
    const local = documentPath(path);
    const kind = existsSync(local) && statSync(local).isDirectory() ? "tree" : "blob";
    return `](${GITHUB}/${kind}/${BRANCH}/${path}${anchor})`;
  });
}

export const PACKAGE_FILES: readonly PackageFile[] = [
  { path: "packages/core/README.md", from: "README.md", transform: fromPackageDirectory },
  { path: "packages/core/LICENSE", from: "LICENSE" },
  { path: "packages/lint/LICENSE", from: "LICENSE" },
  { path: "packages/skills/LICENSE", from: "LICENSE" },
  // the migration guide and the upgrade procedure ship with the codemod that does most of it
  { path: "packages/codemod/MIGRATION.md", from: "MIGRATION.md", transform: toGitHub },
  { path: "packages/codemod/UPGRADE-PROMPT.md", from: "UPGRADE-PROMPT.md", transform: toGitHub },
  { path: "packages/codemod/LICENSE", from: "LICENSE" },
];

/** What a package file must hold: its root file, transformed. */
export function packageFileText(file: PackageFile): string {
  const text = readFileSync(documentPath(file.from), "utf8");
  return file.transform === undefined ? text : file.transform(text);
}
