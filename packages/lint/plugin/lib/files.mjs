// Which files a rule looks at. A rule about one layer of an app (services,
// jobs, routes, client code) takes `files` and `ignore` globs; the defaults
// follow the quickdraw template's layout. Globs are matched against the
// file's path relative to the directory oxlint runs in, or against its
// absolute path when the file lies outside that directory, so keep them
// `**/`-prefixed. They support `**`, `*`, `?` and `{a,b}`.
//
// Client code is also known by what it imports (`inClientScope`): a file
// that imports TanStack Query, the Socket.IO client or quickdraw's client is
// client code wherever oxlint runs from, so the client rules do not depend
// on the working directory; the path globs add files on top.

/** Tests set up and inspect data directly, by design. */
export const TEST_FILES = Object.freeze([
  "**/__tests__/**",
  "**/__mocks__/**",
  "**/test/**",
  "**/tests/**",
  "**/*.test.*",
  "**/*.test-d.*",
  "**/*.spec.*",
]);

/** Service definitions: `apps/api/src/services/**` in the template. */
export const SERVICE_FILES = Object.freeze(["**/services/**"]);

/** Server code that writes or emits: services, jobs and HTTP routes. */
export const SERVER_FILES = Object.freeze([
  "**/services/**",
  "**/jobs/**",
  "**/routes/**",
  "**/routes.*",
]);

/** HTTP route handlers. */
export const ROUTE_FILES = Object.freeze(["**/routes/**", "**/routes.*"]);

/** Client code by path: React components and the web app. */
export const CLIENT_FILES = Object.freeze(["**/*.tsx", "**/*.jsx", "**/apps/web/**"]);

/** Client code by import: a file importing one of these modules (or a subpath of them). */
export const CLIENT_MODULES = Object.freeze([
  "@tanstack/react-query",
  "socket.io-client",
  "@fitzzero/quickdraw-core/client",
]);

/** The JSON Schema of the `files` and `ignore` options. */
export const FILE_OPTIONS = Object.freeze({
  files: {
    type: "array",
    items: { type: "string" },
    description: "Globs of the files the rule checks.",
  },
  ignore: {
    type: "array",
    items: { type: "string" },
    description: "Globs of files the rule skips even when `files` matches them.",
  },
});

/** The JSON Schema of the client rules' `files` and `ignore` options. */
export const CLIENT_FILE_OPTIONS = Object.freeze({
  files: {
    type: "array",
    items: { type: "string" },
    description:
      "Globs of files the rule checks besides those importing a client module (default: `**/*.tsx`, `**/*.jsx`, `**/apps/web/**`).",
  },
  ignore: FILE_OPTIONS.ignore,
});

const compiled = new Map();

function escapeRegExp(text) {
  return text.replace(/[.+^${}()|[\]\\]/g, "\\$&");
}

/** The regular expression source for `glob`, unanchored. */
function globSource(glob) {
  let source = "";
  for (let index = 0; index < glob.length; index += 1) {
    const char = glob[index];
    if (char === "*" && glob[index + 1] === "*") {
      const segmentStart = index === 0 || glob[index - 1] === "/";
      if (segmentStart && glob[index + 2] === "/") {
        // `**/`: any number of whole directories, none included.
        source += "(?:.*/)?";
        index += 2;
      } else {
        source += ".*";
        index += 1;
      }
    } else if (char === "*") {
      source += "[^/]*";
    } else if (char === "?") {
      source += "[^/]";
    } else if (char === "{" && glob.includes("}", index)) {
      const close = glob.indexOf("}", index);
      const options = glob.slice(index + 1, close).split(",");
      source += `(?:${options.map(globSource).join("|")})`;
      index = close;
    } else {
      source += escapeRegExp(char);
    }
  }
  return source;
}

/** `glob` as an anchored regular expression, compiled once. */
export function globToRegExp(glob) {
  let pattern = compiled.get(glob);
  if (pattern === undefined) {
    pattern = new RegExp(`^${globSource(glob.replaceAll("\\", "/"))}$`);
    compiled.set(glob, pattern);
  }
  return pattern;
}

/** Whether `target` (a path or a module specifier) matches one of `globs`. */
export function matchesAny(target, globs) {
  return globs.some((glob) => globToRegExp(glob).test(target));
}

/**
 * The linted file's path with forward slashes: relative to the directory
 * oxlint runs in when the file is inside it, else absolute.
 */
export function lintedPath(context) {
  const filename = context.filename.replaceAll("\\", "/");
  const cwd = (context.cwd ?? "").replaceAll("\\", "/").replace(/\/$/, "");
  if (cwd !== "" && filename.startsWith(`${cwd}/`)) {
    return filename.slice(cwd.length + 1);
  }
  return filename;
}

/**
 * Whether the rule checks the linted file: it matches the `files` option
 * (default `defaults.files`; every file when both are absent) and does not
 * match the `ignore` option (default `defaults.ignore`).
 */
export function inScope(context, options, defaults = {}) {
  const target = lintedPath(context);
  const files = options.files ?? defaults.files;
  if (files !== undefined && !matchesAny(target, files)) {
    return false;
  }
  return !matchesAny(target, options.ignore ?? defaults.ignore ?? []);
}

/** The module a top-level statement imports or re-exports from, if any. */
function importSource(statement) {
  if (
    statement.type === "ImportDeclaration" ||
    statement.type === "ExportAllDeclaration" ||
    statement.type === "ExportNamedDeclaration"
  ) {
    return typeof statement.source?.value === "string" ? statement.source.value : undefined;
  }
  return undefined;
}

/** Whether the linted file imports (or re-exports from) one of `modules` or a subpath of one. */
export function importsAny(context, modules) {
  return context.sourceCode.ast.body.some((statement) => {
    const source = importSource(statement);
    return (
      source !== undefined &&
      modules.some((module) => source === module || source.startsWith(`${module}/`))
    );
  });
}

/**
 * Whether a client rule checks the linted file: it imports one of
 * {@link CLIENT_MODULES}, or its path matches the `files` option (default
 * {@link CLIENT_FILES}); either way not when it matches `ignore` (default
 * `defaults.ignore`).
 */
export function inClientScope(context, options, defaults = {}) {
  const target = lintedPath(context);
  if (matchesAny(target, options.ignore ?? defaults.ignore ?? [])) {
    return false;
  }
  return importsAny(context, CLIENT_MODULES) || matchesAny(target, options.files ?? CLIENT_FILES);
}
