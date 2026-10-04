// The files every published package ships beside its code, kept as copies of
// the repo root's: `npm pack` adds a package directory's README.md and
// LICENSE whatever its `files` list says, so each package holds its own.
// Every copy is also read from `node_modules`, where the package is all
// there is: a relative link out of the package leads nowhere there (the
// core README's `../../packages/lint`, finding F5.7 of the quickdraw-chat
// migration). So the core package's README keeps a link into
// `packages/core` relative to the package and points every other at the
// repository on GitHub, and the migration guide and the upgrade procedure
// the codemod ships point all theirs at GitHub. `bun run readme:sync` (in
// packages/core) writes the copies; `readme.test.ts` checks them.

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
export const RELATIVE_LINK = /\]\((?![a-z][\d+.a-z-]*:|#|\/)([^\s)#]+)(#[^\s)]*)?\)/giu;

/** The repository's files on GitHub, on the branch the guide describes. */
export const GITHUB = "https://github.com/fitzzero/quickdraw";
const BRANCH = "dev";

/** A link to a file or directory of the repository (`path` from its root) on GitHub. */
function onGitHub(path: string, anchor: string): string {
  const local = documentPath(path);
  const kind = existsSync(local) && statSync(local).isDirectory() ? "tree" : "blob";
  return `](${GITHUB}/${kind}/${BRANCH}/${path}${anchor})`;
}

/** A Markdown document's relative links, made absolute links to the repository on GitHub. */
export function toGitHub(text: string): string {
  return text.replace(RELATIVE_LINK, (_, path: string, anchor = "") => onGitHub(path, anchor));
}

/**
 * A root document's relative links, for the copy the package in `directory`
 * ships: a link into the package made relative to it, every other an
 * absolute link to the repository on GitHub.
 */
export function forPackage(directory: string): (text: string) => string {
  const inside = `${directory}/`;
  return (text) =>
    text.replace(RELATIVE_LINK, (_, path: string, anchor = "") =>
      path.startsWith(inside) ? `](${path.slice(inside.length)}${anchor})` : onGitHub(path, anchor),
    );
}

export const PACKAGE_FILES: readonly PackageFile[] = [
  { path: "packages/core/README.md", from: "README.md", transform: forPackage("packages/core") },
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
