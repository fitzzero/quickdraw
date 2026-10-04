// Where the app's parts live. Apps made from the quickdraw template keep
// their method maps and DTOs in `packages/shared`, their services in
// `apps/api` and their web app in `apps/web`, with the Prisma client in
// `packages/db`; each of these can be moved with an option.

import { existsSync, readdirSync, readFileSync } from "node:fs";
import { isAbsolute, join, relative, resolve } from "node:path";

/** Where one package of the app lives. */
export interface PackageDir {
  /** Absolute path of the package directory. */
  readonly dir: string;
  /** Absolute path of its sources (`<dir>/src`). */
  readonly src: string;
  /** Its `package.json` name, which other packages import it by. */
  readonly name: string;
}

/** The parts of an app the codemod reads and writes. */
export interface Layout {
  readonly root: string;
  readonly shared: PackageDir;
  readonly api: PackageDir;
  readonly web: PackageDir | undefined;
  /**
   * The sources (`<dir>/src`, else the directory) of the other workspace
   * packages that depend on quickdraw, such as the database package's test
   * helpers: the 4.x API left in them is rewritten or marked too.
   */
  readonly others: readonly string[];
  /** The package `prisma` is imported from (`@project/db`). */
  readonly dbPackage: string;
}

/** Directories (relative to the repository root) and names that differ from the template's. */
export interface LayoutOptions {
  readonly shared?: string;
  readonly api?: string;
  readonly web?: string;
  readonly dbPackage?: string;
}

/** A directory's `package.json`, parsed, or `undefined` without one. */
function manifestOf(dir: string): Record<string, unknown> | undefined {
  const manifest = join(dir, "package.json");
  if (!existsSync(manifest)) {
    return undefined;
  }
  const parsed: unknown = JSON.parse(readFileSync(manifest, "utf8"));
  return typeof parsed === "object" && parsed !== null
    ? (parsed as Record<string, unknown>)
    : undefined;
}

function packageName(dir: string, fallback: string): string {
  const name = manifestOf(dir)?.name;
  return typeof name === "string" ? name : fallback;
}

const CORE_PACKAGE = "@fitzzero/quickdraw-core";
const DEPENDENCY_FIELDS = [
  "dependencies",
  "devDependencies",
  "peerDependencies",
  "optionalDependencies",
];

/** Whether a package's manifest depends on quickdraw. */
function dependsOnCore(dir: string): boolean {
  const manifest = manifestOf(dir);
  return DEPENDENCY_FIELDS.some((field) => {
    const dependencies = manifest?.[field];
    return (
      typeof dependencies === "object" && dependencies !== null && CORE_PACKAGE in dependencies
    );
  });
}

/** The workspace patterns of the root `package.json` (`workspaces`, or `workspaces.packages`). */
function workspacePatterns(root: string): string[] {
  const workspaces = manifestOf(root)?.workspaces;
  const patterns =
    typeof workspaces === "object" && workspaces !== null && "packages" in workspaces
      ? workspaces.packages
      : workspaces;
  return Array.isArray(patterns)
    ? patterns.filter((pattern): pattern is string => typeof pattern === "string")
    : [];
}

/** The package directories `patterns` name: `dir/*` (one level) or a directory. */
function workspaceDirs(root: string, patterns: readonly string[]): string[] {
  return patterns.flatMap((pattern) => {
    if (pattern.startsWith("!")) {
      return [];
    }
    if (!pattern.endsWith("/*")) {
      return [resolve(root, pattern)];
    }
    const parent = resolve(root, pattern.slice(0, -2));
    return existsSync(parent)
      ? readdirSync(parent, { withFileTypes: true })
          .filter((entry) => entry.isDirectory())
          .map((entry) => join(parent, entry.name))
      : [];
  });
}

/** The sources of the workspace packages other than `known` that depend on quickdraw. */
function otherSources(root: string, known: readonly string[]): string[] {
  return workspaceDirs(root, workspacePatterns(root))
    .filter((dir) => !known.includes(dir) && dependsOnCore(dir))
    .map((dir) => (existsSync(join(dir, "src")) ? join(dir, "src") : dir))
    .toSorted();
}

function packageDir(root: string, dir: string, fallbackName: string): PackageDir | undefined {
  const absolute = isAbsolute(dir) ? dir : resolve(root, dir);
  const src = join(absolute, "src");
  if (!existsSync(src)) {
    return undefined;
  }
  return { dir: absolute, src, name: packageName(absolute, fallbackName) };
}

/** Finds the app's packages under `root`, failing with a message when shared or api is missing. */
export function findLayout(root: string, options: LayoutOptions = {}): Layout {
  const absoluteRoot = resolve(root);
  const shared = packageDir(absoluteRoot, options.shared ?? "packages/shared", "@project/shared");
  const api = packageDir(absoluteRoot, options.api ?? "apps/api", "@project/api");
  if (shared === undefined || api === undefined) {
    const missing =
      shared === undefined ? (options.shared ?? "packages/shared") : (options.api ?? "apps/api");
    throw new Error(
      `quickdraw-codemod: no ${missing}/src under ${absoluteRoot}. Pass --shared and --api when the app is not laid out like the quickdraw template.`,
    );
  }
  const web = packageDir(absoluteRoot, options.web ?? "apps/web", "@project/web");
  const dbDir = resolve(absoluteRoot, "packages/db");
  const dbPackage = options.dbPackage ?? packageName(dbDir, "@project/db");
  const known = [shared.dir, api.dir, ...(web === undefined ? [] : [web.dir])];
  return {
    root: absoluteRoot,
    shared,
    api,
    web,
    others: otherSources(absoluteRoot, known),
    dbPackage,
  };
}

/** `file` relative to the repository root, with forward slashes. */
export function repoPath(layout: Layout, file: string): string {
  return relative(layout.root, file).split("\\").join("/");
}
