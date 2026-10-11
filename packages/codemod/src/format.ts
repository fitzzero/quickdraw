// The app's own formatter, run on the files a run wrote, so the output passes
// the app's format check (a pre-commit hook, CI) as it is written, and the
// report, built after it, points at the lines the formatted files have. The
// formatter is the first of oxfmt, prettier and Biome the root package.json
// depends on (or its `format` script calls) whose binary is installed.

import { spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { join, relative, sep } from "node:path";

/** What formatting the files a run wrote did. */
export interface FormatResult {
  /** Whether every file is formatted. */
  readonly ok: boolean;
  /** The files (relative to the root) the formatter left unformatted, or failed on. */
  readonly unformatted: readonly string[];
  /** The exit code of the first call that failed (0 when none did). */
  readonly status: number;
  /** The formatter's own output (stdout and stderr) from the calls that failed. */
  readonly output: string;
}

/** A formatter the run found. */
export interface Formatter {
  readonly name: string;
  /** Whether it formats Markdown (the report). */
  readonly markdown: boolean;
  /**
   * Formats `files` (absolute paths) in place, then lists the ones still
   * unformatted. Files the app's formatter config ignores are left as written.
   */
  readonly format: (files: readonly string[]) => FormatResult;
}

/** Options for {@link findFormatter}; `batch` (files per call) is for tests. */
export interface FormatterOptions {
  readonly batch?: number;
}

interface Known {
  readonly name: string;
  readonly packageName: string;
  readonly bin: string;
  readonly write: readonly string[];
  /** The arguments that list the files it would change (exit 1 when it lists some). */
  readonly listDifferent?: readonly string[];
  readonly markdown: boolean;
}

// Each is told not to fail on files its config ignores: a call given only
// ignored files (the report, in an app that ignores Markdown) is no error.
const KNOWN: readonly Known[] = [
  {
    name: "oxfmt",
    packageName: "oxfmt",
    bin: "oxfmt",
    write: ["--write", "--no-error-on-unmatched-pattern"],
    listDifferent: ["--list-different", "--no-error-on-unmatched-pattern"],
    markdown: true,
  },
  {
    name: "prettier",
    packageName: "prettier",
    bin: "prettier",
    write: ["--write", "--ignore-unknown"],
    listDifferent: ["--list-different", "--ignore-unknown"],
    markdown: true,
  },
  {
    name: "biome",
    packageName: "@biomejs/biome",
    bin: "biome",
    write: ["format", "--write", "--no-errors-on-unmatched"],
    markdown: false,
  },
];

// At most this many files, and about this many characters of paths, per call
// (Windows caps a command line at 32,767 characters).
const BATCH_FILES = 100;
const BATCH_CHARS = 24_000;

/** Splits `files` into batches of at most `size` files and about `chars` characters. */
export function batches(
  files: readonly string[],
  size = BATCH_FILES,
  chars = BATCH_CHARS,
): string[][] {
  const out: string[][] = [];
  let current: string[] = [];
  let length = 0;
  for (const file of files) {
    if (current.length > 0 && (current.length >= size || length + file.length + 1 > chars)) {
      out.push(current);
      current = [];
      length = 0;
    }
    current.push(file);
    length += file.length + 1;
  }
  if (current.length > 0) {
    out.push(current);
  }
  return out;
}

/** The files a formatter is given: the code and the Markdown a run writes. */
export const FORMATTED = /\.(?:[cm]?[jt]sx?|md)$/u;

function manifest(root: string): {
  readonly dependencies: Record<string, unknown>;
  readonly script: string;
} {
  const path = join(root, "package.json");
  if (!existsSync(path)) {
    return { dependencies: {}, script: "" };
  }
  const parsed = JSON.parse(readFileSync(path, "utf8")) as {
    dependencies?: Record<string, unknown>;
    devDependencies?: Record<string, unknown>;
    scripts?: Record<string, unknown>;
  };
  const format = parsed.scripts?.format;
  return {
    dependencies: { ...parsed.dependencies, ...parsed.devDependencies },
    script: typeof format === "string" ? format : "",
  };
}

/** The app's formatter, when it has one installed. */
export function findFormatter(root: string, options: FormatterOptions = {}): Formatter | undefined {
  const { dependencies, script } = manifest(root);
  for (const known of KNOWN) {
    const bin = join(root, "node_modules", ".bin", known.bin);
    const configured =
      known.packageName in dependencies || new RegExp(`\\b${known.bin}\\b`, "u").test(script);
    if (!configured || !existsSync(bin)) {
      continue;
    }
    const run = (args: readonly string[], files: readonly string[]): Call =>
      spawn(bin, root, args, files);
    const different = (batch: readonly string[]): readonly string[] | Call =>
      listDifferent(known, run, batch);
    return {
      name: known.name,
      markdown: known.markdown,
      format: (files) => {
        const wanted = files
          .filter((file) => known.markdown || !file.endsWith(".md"))
          .map((file) => relative(root, file).split(sep).join("/"));
        const unformatted = new Set<string>();
        const output: string[] = [];
        let status = 0;
        const leave = (batch: readonly string[], call?: Call): void => {
          for (const file of batch) {
            unformatted.add(file);
          }
          if (status === 0) {
            status = call?.status ?? 1;
          }
          if (call !== undefined && call.output !== "") {
            output.push(call.output);
          }
        };
        for (const batch of batches(wanted, options.batch)) {
          const written = run(known.write, batch);
          if (written.status !== 0) {
            leave(batch, written);
            continue;
          }
          let left = different(batch);
          if (Array.isArray(left) && left.length > 0) {
            // Once more: a second pass settles what the first one changed.
            const again = run(known.write, left);
            const rest = left;
            left = again.status === 0 ? different(left) : again;
            if (!Array.isArray(left)) {
              leave(rest, left as Call);
              continue;
            }
          }
          if (!Array.isArray(left)) {
            leave(batch, left as Call);
          } else if (left.length > 0) {
            leave(left);
          }
        }
        return {
          ok: unformatted.size === 0,
          unformatted: [...unformatted],
          status,
          output: output.join("\n"),
        };
      },
    };
  }
  return undefined;
}

interface Call {
  readonly status: number;
  readonly stdout: string;
  readonly output: string;
}

function spawn(bin: string, root: string, args: readonly string[], files: readonly string[]): Call {
  const result = spawnSync(bin, [...args, ...files], {
    cwd: root,
    encoding: "utf8",
    maxBuffer: 1024 ** 3,
  });
  const stdout = typeof result.stdout === "string" ? result.stdout : "";
  return {
    status: result.error === undefined ? (result.status ?? 1) : 1,
    stdout,
    output: [stdout, result.stderr, result.error?.message]
      .filter((text): text is string => typeof text === "string" && text.trim() !== "")
      .join("\n"),
  };
}

/** The files of `batch` the formatter would change, or the call that failed. */
function listDifferent(
  known: Known,
  run: (args: readonly string[], files: readonly string[]) => Call,
  batch: readonly string[],
): readonly string[] | Call {
  if (known.listDifferent === undefined) {
    return [];
  }
  const result = run(known.listDifferent, batch);
  if (result.status === 0) {
    return [];
  }
  const inBatch = new Set(batch);
  const listed = result.stdout
    .split(/\r?\n/u)
    .map((line) => line.trim().split(sep).join("/"))
    .filter((line) => line !== "");
  return result.status === 1 && listed.length > 0 && listed.every((file) => inBatch.has(file))
    ? listed
    : result;
}
