// Where the app's parts live. Apps made from the quickdraw template keep
// their method maps and DTOs in `packages/shared`, their services in
// `apps/api` and their web app in `apps/web`, with the Prisma client in
// `packages/db`; each of these can be moved with an option.

import { existsSync, readFileSync } from "node:fs";
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

function packageName(dir: string, fallback: string): string {
  const manifest = join(dir, "package.json");
  if (!existsSync(manifest)) {
    return fallback;
  }
  const parsed: unknown = JSON.parse(readFileSync(manifest, "utf8"));
  const name =
    typeof parsed === "object" && parsed !== null && "name" in parsed ? parsed.name : undefined;
  return typeof name === "string" ? name : fallback;
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
  return { root: absoluteRoot, shared, api, web, dbPackage };
}

/** `file` relative to the repository root, with forward slashes. */
export function repoPath(layout: Layout, file: string): string {
  return relative(layout.root, file).split("\\").join("/");
}
