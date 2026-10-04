// The app's own formatter, run on the files a run wrote, so the output passes
// the app's format check (a pre-commit hook, CI) as it is written, and the
// report, built after it, points at the lines the formatted files have. The
// formatter is the first of oxfmt, prettier and Biome the root package.json
// depends on (or its `format` script calls) whose binary is installed.

import { spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

/** A formatter the run found. */
export interface Formatter {
  readonly name: string;
  /** Whether it formats Markdown (the report). */
  readonly markdown: boolean;
  /** Formats `files` (absolute paths) in place; returns whether it succeeded. */
  readonly format: (files: readonly string[]) => boolean;
}

interface Known {
  readonly name: string;
  readonly packageName: string;
  readonly bin: string;
  readonly args: (files: readonly string[]) => string[];
  readonly markdown: boolean;
}

const KNOWN: readonly Known[] = [
  {
    name: "oxfmt",
    packageName: "oxfmt",
    bin: "oxfmt",
    args: (files) => ["--write", ...files],
    markdown: true,
  },
  {
    name: "prettier",
    packageName: "prettier",
    bin: "prettier",
    args: (files) => ["--write", "--ignore-unknown", ...files],
    markdown: true,
  },
  {
    name: "biome",
    packageName: "@biomejs/biome",
    bin: "biome",
    args: (files) => ["format", "--write", ...files],
    markdown: false,
  },
];

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
export function findFormatter(root: string): Formatter | undefined {
  const { dependencies, script } = manifest(root);
  for (const known of KNOWN) {
    const bin = join(root, "node_modules", ".bin", known.bin);
    const configured =
      known.packageName in dependencies || new RegExp(`\\b${known.bin}\\b`, "u").test(script);
    if (!configured || !existsSync(bin)) {
      continue;
    }
    return {
      name: known.name,
      markdown: known.markdown,
      format: (files) => {
        const wanted = files.filter((file) => known.markdown || !file.endsWith(".md"));
        if (wanted.length === 0) {
          return true;
        }
        const result = spawnSync(bin, known.args(wanted), {
          cwd: root,
          encoding: "utf8",
          maxBuffer: 1024 ** 3,
        });
        return result.error === undefined && result.status === 0;
      },
    };
  }
  return undefined;
}
