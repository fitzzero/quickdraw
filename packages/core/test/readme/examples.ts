// The code examples of the repo's README (the package README), of its
// migration guide (MIGRATION.md) and of the shipped `quickdraw-new-service`
// skill are copies of files in this directory, a small app laid out like the
// quickdraw template, which `bun run typecheck` compiles (the guide's 4.x
// "before" examples are copies of packages/codemod/test/guide-v4, a 4.1 app
// the codemod's tests typecheck against the published 4.1.0): `tsconfig.json` here resolves the package's
// own name to its sources, `@project/db` to a Prisma client over core's test
// schema, and `@project/shared` to the contracts here. A copied example is
// the fenced block right after a marker naming its source:
//
//   <!-- example: apps/api/src/services/task.ts -->      the whole file
//   <!-- example: apps/api/src/kits.ts#crud -->           one region of a file
//
// A region is the lines between `// #region <name>` and `// #endregion`. A
// region inside a block (a class's members, say) is copied with the region
// marker's indentation taken off every line.
// `readme.test.ts` checks every copy and that every TypeScript block is one;
// `bun run readme:sync` (in packages/core) rewrites the copies.

import { existsSync, readFileSync } from "node:fs";
import { dirname, extname, join } from "node:path";
import { fileURLToPath } from "node:url";

/** This directory: where example sources are named from. */
export const EXAMPLES_DIR = dirname(fileURLToPath(import.meta.url));

const REPO_ROOT = join(EXAMPLES_DIR, "..", "..", "..", "..");

/** The documents whose examples are copies, from the repo root. */
export const DOCUMENTS = [
  "README.md",
  "MIGRATION.md",
  "packages/skills/skills/quickdraw-new-service/SKILL.md",
] as const;

/** A document's path on disk. */
export function documentPath(document: string): string {
  return join(REPO_ROOT, document);
}

const MARKER = /^<!-- example: ([\w./-]+?)(?:#([\w-]+))? -->$/;
const FENCE = /^(`{3,})([\w-]*)\s*$/;
const TYPESCRIPT = new Set(["ts", "tsx", "typescript"]);
const REGION_START = /^\s*\/\/ #region ([\w-]+)$/;
const REGION_END = /^\s*\/\/ #endregion\b/;

/** One copied example: where it sits in the document and what it copies. */
export interface Example {
  /** `file` or `file#region`, as the marker names it. */
  readonly source: string;
  readonly file: string;
  readonly region: string | undefined;
  /** The fence's language. */
  readonly lang: string;
  /** The block's lines, without the fences. */
  readonly code: string;
  /** The block's first and last line (the fences), 0-based. */
  readonly open: number;
  readonly close: number;
}

/** What a document holds: its copied examples, and the problems found reading it. */
export interface ParsedDocument {
  readonly lines: readonly string[];
  readonly examples: readonly Example[];
  readonly problems: readonly string[];
}

/** The fenced block opening at line `open`: its language and closing line. */
function blockAt(
  lines: readonly string[],
  open: number,
): { lang: string; close: number } | undefined {
  const fence = FENCE.exec(lines[open] ?? "");
  if (fence === null) {
    return undefined;
  }
  const [, ticks = "```", lang = ""] = fence;
  for (let close = open + 1; close < lines.length; close += 1) {
    if (lines[close]?.trimEnd() === ticks) {
      return { lang, close };
    }
  }
  return undefined;
}

/** Reads a document: every marked example, and every TypeScript block without a marker. */
export function parseDocument(text: string): ParsedDocument {
  const lines = text.split("\n");
  const examples: Example[] = [];
  const problems: string[] = [];
  let marker: RegExpExecArray | null = null;
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index] ?? "";
    const block = blockAt(lines, index);
    if (block === undefined) {
      marker = MARKER.exec(line) ?? (line.trim() === "" ? marker : null);
      continue;
    }
    if (marker !== null) {
      const [, file = "", region] = marker;
      const source = region === undefined ? file : `${file}#${region}`;
      const code = lines.slice(index + 1, block.close).join("\n");
      examples.push({
        source,
        file,
        region,
        lang: block.lang,
        code,
        open: index,
        close: block.close,
      });
    } else if (TYPESCRIPT.has(block.lang)) {
      problems.push(`the ${block.lang} block on line ${index + 1} is not a copy of an example`);
    }
    marker = null;
    index = block.close;
  }
  return { lines, examples, problems };
}

/** The text an example copies: its file, or one region of it, without region markers. */
export function sourceOf(file: string, region: string | undefined): string | undefined {
  const path = join(EXAMPLES_DIR, file);
  if (!existsSync(path)) {
    return undefined;
  }
  const lines = readFileSync(path, "utf8").trimEnd().split("\n");
  if (region === undefined) {
    return lines.filter((line) => !REGION_START.test(line) && !REGION_END.test(line)).join("\n");
  }
  const start = lines.findIndex((line) => REGION_START.exec(line)?.[1] === region);
  const end = lines.findIndex((line, index) => index > start && REGION_END.test(line));
  if (start === -1 || end === -1) {
    return undefined;
  }
  const indent = /^\s*/.exec(lines[start] ?? "")?.[0] ?? "";
  return lines
    .slice(start + 1, end)
    .map((line) => (line.startsWith(indent) ? line.slice(indent.length) : line.trimStart()))
    .join("\n");
}

/** The fence language a source file's examples use. */
export function langOf(file: string): string {
  return extname(file) === ".tsx" ? "tsx" : "ts";
}

/** Every way a document's examples differ from their sources. */
export function checkDocument(name: string, text: string): string[] {
  const { examples, problems } = parseDocument(text);
  const found = problems.map((problem) => `${name}: ${problem}`);
  for (const example of examples) {
    const source = sourceOf(example.file, example.region);
    const where = `${name} line ${example.open + 1} (${example.source})`;
    if (source === undefined) {
      found.push(`${where}: no such example in test/readme`);
    } else if (example.code !== source || example.lang !== langOf(example.file)) {
      found.push(`${where} is not a copy of its source: run bun run readme:sync in packages/core`);
    }
  }
  return found;
}

/** `text` with every example replaced by its source, as `readme:sync` writes it. */
export function syncDocument(text: string): string {
  const { lines, examples } = parseDocument(text);
  const out = [...lines];
  for (const example of [...examples].reverse()) {
    const source = sourceOf(example.file, example.region);
    if (source !== undefined) {
      out.splice(
        example.open,
        example.close - example.open + 1,
        `\`\`\`${langOf(example.file)}`,
        ...source.split("\n"),
        "```",
      );
    }
  }
  return out.join("\n");
}
