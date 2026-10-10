// `quickdraw-docs`: Markdown API docs generated from an app's contracts
// (RFC 0003 sections 2 and 12.5), one page per service plus an index. It
// loads a module, takes every contract it exports (alone, or in a map such
// as the one given to `createQuickdrawClient`), and writes the pages; with
// `--check` it writes nothing and exits 1 when the pages on disk differ. It
// reads contracts, never source code, so what it documents is what clients
// are typed from. With `--services <module>` (a module exporting the
// services, each or in a list, as the server takes them) each page also says
// who may call what: each method's access form and `rowless`, the service's
// row policy, admin bypass, `watchAccess` and field levels, who may open a
// collection's scope, a channel's access, a stream's computed seed
// (`access.ts`), and which other services it depends on, with a graph of
// those on the index (`dependencies.ts`); without it the pages are the
// contracts' alone.
//
//   quickdraw-docs packages/shared/src/contracts/index.ts --out docs/api
//   quickdraw-docs packages/shared/src/contracts/index.ts --services apps/api/src/services/index.ts
//   quickdraw-docs packages/shared/src/contracts/index.ts --out docs/api --check
//
// A TypeScript module is imported as Node imports it (Node 24 strips types),
// and through `tsx` when that fails and the project has `tsx` installed, so
// extensionless imports and `tsconfig` paths work too. The services module
// loads every module the server does, so a workspace package whose
// `package.json` points at its build must be built first (finding F6.7 of
// the quickdraw-chat migration): a missing built file is reported with that
// hint (`buildHint`).

import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { join, relative, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import type { AnyContract } from "../contract/defineContract";
import { servicesOf, type ServiceDoc } from "./access";
import { dependenciesOf } from "./dependencies";
import { fileOf, GENERATED_MARKER, renderIndex, renderService } from "./render";

const USAGE = `Usage: quickdraw-docs <module> [--services <module>] [--out <dir>] [--check]

  <module>              a module exporting the app's contracts: each one, or a map of them
  --services <module>   a module exporting the services (each, or a list of them): the pages
                        then also say who may call each method, from the services' access,
                        and which services each depends on, with a graph on the index
  --out <dir>           where the pages go: one per service, plus README.md (default: docs/api)
  --check               write nothing; exit 1 when the pages on disk differ from the contracts
`;

/** The index page's file name. */
export const INDEX_FILE = "README.md";

/** Where `main` writes its output; the CLI passes the process's streams. */
export interface DocsOutput {
  out(text: string): void;
  err(text: string): void;
}

const CONTRACT_KEYS = [
  "projections",
  "fields",
  "methods",
  "collections",
  "streams",
  "channels",
  "events",
] as const;

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** True for what `defineContract` returns: a frozen object with a name and every member map. */
export function isContract(value: unknown): value is AnyContract {
  return (
    isRecord(value) &&
    Object.isFrozen(value) &&
    typeof value.name === "string" &&
    "entity" in value &&
    CONTRACT_KEYS.every((key) => isRecord(value[key]))
  );
}

/**
 * Every contract a module exports, directly or as the values of an exported
 * map (`{ task, project }`), in name order. Two different contracts with one
 * service name are an error, as they would be on a server.
 */
export function contractsOf(exports: Readonly<Record<string, unknown>>): AnyContract[] {
  const found = new Map<string, AnyContract>();
  const add = (contract: AnyContract): void => {
    const known = found.get(contract.name);
    if (known !== undefined && known !== contract) {
      throw new Error(`two different contracts are named "${contract.name}"`);
    }
    found.set(contract.name, contract);
  };
  for (const value of Object.values(exports)) {
    if (isContract(value)) {
      add(value);
    } else if (isRecord(value)) {
      Object.values(value).filter(isContract).forEach(add);
    }
  }
  return [...found.values()].sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
}

/** Options of {@link generateDocs}. */
export interface GenerateOptions {
  /**
   * The app's services by name (`servicesOf`): each page then says who may
   * call what. A service no contract documents is an error.
   */
  readonly services?: ReadonlyMap<string, ServiceDoc>;
}

/** The pages for `contracts`: file name to content, the index included. */
export function generateDocs(
  contracts: readonly AnyContract[],
  options: GenerateOptions = {},
): ReadonlyMap<string, string> {
  const { services } = options;
  if (services !== undefined) {
    const documented = new Set(contracts.map((contract) => contract.name));
    const strays = [...services.keys()].filter((name) => !documented.has(name));
    if (strays.length > 0) {
      throw new Error(
        `the services module defines ${strays.join(", ")}, but the contracts module exports no contract of ${strays.length === 1 ? "that name" : "those names"}`,
      );
    }
  }
  const dependencies = services === undefined ? undefined : dependenciesOf(contracts, services);
  const files = new Map<string, string>();
  for (const contract of contracts) {
    const file = fileOf(contract);
    if (file === INDEX_FILE || files.has(file)) {
      throw new Error(`the page of ${contract.name} would overwrite ${file}`);
    }
    files.set(
      file,
      renderService(
        contract,
        services === undefined
          ? undefined
          : {
              service: services.get(contract.name),
              dependencies: dependencies?.get(contract.name),
            },
      ),
    );
  }
  files.set(INDEX_FILE, renderIndex(contracts, dependencies));
  return files;
}

/** What `syncDocs` found or did, file by file. */
export interface DocsReport {
  readonly written: readonly string[];
  readonly unchanged: readonly string[];
  readonly removed: readonly string[];
}

function readText(path: string): string | undefined {
  try {
    return readFileSync(path, "utf8");
  } catch {
    return undefined;
  }
}

/** The generated pages already in `dir`: Markdown files that start with the marker. */
function generatedIn(dir: string): string[] {
  if (!existsSync(dir)) {
    return [];
  }
  return readdirSync(dir)
    .filter((name) => name.endsWith(".md"))
    .filter((name) => readText(join(dir, name))?.startsWith(GENERATED_MARKER) === true)
    .sort();
}

/**
 * Brings `dir` in line with `files`: writes what differs and removes the
 * generated pages no contract makes any more. With `check`, it changes
 * nothing and reports the same as what it would do. A file that does not
 * start with the generated marker is never replaced or removed: one in the
 * way of a page fails the whole run before anything is written.
 */
export function syncDocs(
  files: ReadonlyMap<string, string>,
  dir: string,
  check: boolean,
): DocsReport {
  const foreign = [...files.keys()].filter((name) => {
    const existing = readText(join(dir, name));
    return existing !== undefined && !existing.startsWith(GENERATED_MARKER);
  });
  if (foreign.length > 0) {
    throw new Error(
      `${foreign.join(", ")} in ${dir} ${foreign.length === 1 ? "was" : "were"} not written by quickdraw-docs: move ${foreign.length === 1 ? "it" : "them"}, or write the pages to another --out`,
    );
  }
  const written: string[] = [];
  const unchanged: string[] = [];
  for (const [name, content] of files) {
    if (readText(join(dir, name)) === content) {
      unchanged.push(name);
      continue;
    }
    written.push(name);
    if (!check) {
      mkdirSync(dir, { recursive: true });
      writeFileSync(join(dir, name), content);
    }
  }
  const removed = generatedIn(dir).filter((name) => !files.has(name));
  if (!check) {
    for (const name of removed) {
      rmSync(join(dir, name));
    }
  }
  return { written, unchanged, removed };
}

/** `tsx`'s `tsImport`, from the project around `dir`, when it is installed there. */
async function tsxImport(
  dir: string,
): Promise<((specifier: string, parent: string) => Promise<unknown>) | undefined> {
  let resolved: string;
  try {
    resolved = createRequire(join(dir, "package.json")).resolve("tsx/esm/api");
  } catch {
    return undefined;
  }
  const api = (await import(pathToFileURL(resolved).href)) as { readonly tsImport?: unknown };
  return typeof api.tsImport === "function"
    ? (api.tsImport as (specifier: string, parent: string) => Promise<unknown>)
    : undefined;
}

/**
 * Node's codes for a module it could not resolve or load as written: an
 * extensionless import or a `tsconfig` path, a directory import, `.tsx`, or
 * TypeScript its type stripping cannot run. `tsx` may load those.
 */
const LOADER_ERRORS: ReadonlySet<string> = new Set([
  "ERR_MODULE_NOT_FOUND",
  "ERR_UNSUPPORTED_DIR_IMPORT",
  "ERR_UNKNOWN_FILE_EXTENSION",
  "ERR_UNSUPPORTED_TYPESCRIPT_SYNTAX",
  "ERR_INVALID_TYPESCRIPT_SYNTAX",
  "ERR_UNSUPPORTED_NODE_MODULES_TYPE_STRIPPING",
]);

/**
 * True when importing failed in Node's loader (see {@link LOADER_ERRORS}),
 * not in the module's own code: only then is the module loaded again
 * through `tsx`, so a module that throws runs once and reports its own error.
 */
export function failedToLoad(error: unknown): boolean {
  const code: unknown =
    typeof error === "object" && error !== null ? Reflect.get(error, "code") : undefined;
  return typeof code === "string" && LOADER_ERRORS.has(code);
}

/** A built file a package's `package.json` points at: under a `dist/` or `build/` directory. */
const BUILT_FILE = /[\\/](?:dist|build)[\\/]/;

/**
 * `error` with a hint when it names a missing built file: a workspace
 * package the module imports was not built (`bun run build` first); else
 * `error` itself.
 */
export function buildHint(error: unknown, file: string, cwd: string): unknown {
  const message = error instanceof Error ? error.message : String(error);
  if (Reflect.get(Object(error), "code") !== "ERR_MODULE_NOT_FOUND" || !BUILT_FILE.test(message)) {
    return error;
  }
  return new Error(
    `could not import ${relative(cwd, file)}: ${message}. A workspace package it imports loads from its build, which is missing: build the workspace (bun run build) before generating the docs`,
    { cause: error },
  );
}

/** Imports the module at `file`: natively, then through `tsx` for TypeScript Node cannot load alone. */
async function importModule(file: string, cwd: string): Promise<Readonly<Record<string, unknown>>> {
  const url = pathToFileURL(file).href;
  try {
    return (await import(url)) as Readonly<Record<string, unknown>>;
  } catch (error) {
    if (!/\.[cm]?tsx?$/.test(file) || !failedToLoad(error)) {
      throw buildHint(error, file, cwd);
    }
    const tsImport = await tsxImport(cwd);
    if (tsImport === undefined) {
      throw new Error(
        `could not import ${relative(cwd, file)} (${error instanceof Error ? error.message : String(error)}); install tsx in the project to load TypeScript with extensionless imports or tsconfig paths`,
        { cause: error },
      );
    }
    try {
      return (await tsImport(url, pathToFileURL(join(cwd, "package.json")).href)) as Readonly<
        Record<string, unknown>
      >;
    } catch (again) {
      throw buildHint(again, file, cwd);
    }
  }
}

interface Options {
  readonly module: string;
  readonly services: string | undefined;
  readonly out: string;
  readonly check: boolean;
}

/** The options in `args`, or the usage problem. */
function parseArgs(args: readonly string[]): Options | string {
  let target: string | undefined;
  let services: string | undefined;
  let out = "docs/api";
  let check = false;
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    const value = args[index + 1];
    if (arg === "--check") {
      check = true;
    } else if (arg === "--out" || arg === "--services") {
      if (value === undefined || value.startsWith("-")) {
        return arg === "--out" ? "--out needs a directory" : "--services needs a module";
      }
      if (arg === "--out") {
        out = value;
      } else {
        services = value;
      }
      index += 1;
    } else if (arg !== undefined && !arg.startsWith("-") && target === undefined) {
      target = arg;
    } else {
      return `unknown argument "${String(arg)}"`;
    }
  }
  return target === undefined
    ? "name the module that exports the contracts"
    : { module: target, services, out, check };
}

function report(result: DocsReport, out: string, check: boolean, io: DocsOutput): number {
  if (!check) {
    io.out(
      `quickdraw-docs: ${out}: ${result.written.length} written, ${result.unchanged.length} unchanged, ${result.removed.length} removed\n`,
    );
    return 0;
  }
  const drift = [
    ...result.written.map((name) => `${name} differs from the contracts`),
    ...result.removed.map((name) => `${name} documents a service no contract has`),
  ];
  if (drift.length === 0) {
    io.out(`quickdraw-docs: ${out} matches the contracts\n`);
    return 0;
  }
  io.err(
    `${drift.map((line) => `quickdraw-docs: ${out}/${line}\n`).join("")}quickdraw-docs: ${drift.length} page(s) out of date: run quickdraw-docs without --check\n`,
  );
  return 1;
}

/**
 * Runs the command with `args` (the arguments after `quickdraw-docs`) in
 * `cwd`, and resolves with its exit code: 0, 1 when `--check` finds drift
 * or the module cannot be documented, 2 for a usage error.
 */
export async function main(
  args: readonly string[],
  io: DocsOutput,
  cwd: string = process.cwd(),
): Promise<number> {
  if (args.includes("--help") || args.includes("-h")) {
    io.out(USAGE);
    return 0;
  }
  const options = parseArgs(args);
  if (typeof options === "string") {
    io.err(`quickdraw-docs: ${options}\n\n${USAGE}`);
    return 2;
  }
  try {
    const contracts = contractsOf(await importModule(resolve(cwd, options.module), cwd));
    if (contracts.length === 0) {
      throw new Error(`${options.module} exports no contract`);
    }
    const services =
      options.services === undefined
        ? undefined
        : servicesOf(await importModule(resolve(cwd, options.services), cwd));
    if (services?.size === 0) {
      throw new Error(`${String(options.services)} exports no service`);
    }
    const files = generateDocs(contracts, services === undefined ? {} : { services });
    const result = syncDocs(files, resolve(cwd, options.out), options.check);
    return report(result, options.out, options.check, io);
  } catch (error) {
    io.err(`quickdraw-docs: ${error instanceof Error ? error.message : String(error)}\n`);
    return 1;
  }
}
