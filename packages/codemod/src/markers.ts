// Review markers: the comments the codemod leaves wherever a person (or an
// agent) has to decide something. A marker reviews the statement, member or
// property right below it:
//
//   // quickdraw-migrate: review [emit] entity frames follow tracked writes: delete this call
//   this.emitUpdate(input.id, updated);
//
// The report (`report.ts`) is read back from the markers in the code, so it
// always matches the files, and a second run finds the same markers and
// writes the same report.

import { Node, type SourceFile } from "ts-morph";
import { type Edit, indentAt, statementOf } from "./text";

/** The text every marker starts with. */
export const MARKER = "quickdraw-migrate: review";

/** The kinds of item a marker can name, in the order the report lists them. */
export const CATEGORIES = [
  "contract",
  "access",
  "access-override",
  "projection",
  "collection",
  "emit",
  "write",
  "raw-sql",
  "lifecycle",
  "admin",
  "kit",
  "channel",
  "this",
  "context",
  "client",
  "server",
  "v4-api",
  "carve-out",
] as const;

export type Category = (typeof CATEGORIES)[number];

/** A marker found in a file. */
export interface FoundMarker {
  /** The file, relative to the repository root. */
  readonly file: string;
  /** 1-based. */
  readonly line: number;
  readonly category: Category;
  readonly message: string;
}

const PATTERN = new RegExp(`//\\s*${MARKER} \\[([a-z0-9-]+)\\] (.*)$`, "u");

/** A marker comment's text, without indentation. */
export function markerText(category: Category, message: string): string {
  return `// ${MARKER} [${category}] ${message}`;
}

function isCategory(value: string): value is Category {
  return (CATEGORIES as readonly string[]).includes(value);
}

/** Every marker in `text`, the contents of `file`. */
export function findMarkers(text: string, file: string): FoundMarker[] {
  const found: FoundMarker[] = [];
  text.split("\n").forEach((line, index) => {
    const match = PATTERN.exec(line);
    const category = match?.[1] ?? "";
    if (match !== null && isCategory(category)) {
      found.push({ file, line: index + 1, category, message: (match[2] ?? "").trim() });
    }
  });
  return found;
}

/** Whether `node` is the first thing on its line (only whitespace before it). */
function startsLine(node: Node): boolean {
  const text = node.getSourceFile().getFullText();
  const start = node.getStart();
  const lineStart = text.lastIndexOf("\n", start - 1) + 1;
  return text.slice(lineStart, start).trim() === "";
}

/**
 * The node a marker about `target` goes above: `target` itself when it
 * starts its line, else the nearest enclosing node that does. A marker
 * written above a property of a one-line literal (`{ w: a, h: b }`) would
 * land after the text before it on that line, as a trailing comment.
 */
export function markerAnchor(target: Node): Node {
  let node = target;
  while (!startsLine(node)) {
    const parent = node.getParent();
    if (parent === undefined || Node.isSourceFile(parent)) {
      break;
    }
    node = parent;
  }
  return node;
}

/** Whether the comments right above `node` already hold this marker. */
export function hasMarker(node: Node, category: Category, message: string): boolean {
  const text = markerText(category, message);
  return node.getLeadingCommentRanges().some((range) => range.getText().trim() === text);
}

/**
 * Collects marker insertions for one file. Each marker goes above the
 * statement (or member, or property) holding the node it is about, or above
 * the nearest enclosing one that starts its own line (`markerAnchor`), once
 * per statement, and never twice: a statement that already carries the
 * same marker (from an earlier run) gets none.
 */
export class MarkerSet {
  private readonly seen = new Set<string>();
  readonly edits: Edit[] = [];

  constructor(private readonly file: SourceFile) {}

  /** Marks the statement holding `node`. */
  add(node: Node, category: Category, message: string): void {
    this.addAbove(statementOf(node), category, message);
  }

  /** Marks `target` itself (or, inside a line, the node starting that line). */
  addAbove(target: Node, category: Category, message: string): void {
    const anchor = markerAnchor(target);
    const key = `${String(anchor.getStart())}:${category}:${message}`;
    if (this.seen.has(key) || hasMarker(anchor, category, message)) {
      return;
    }
    this.seen.add(key);
    const start = anchor.getStart();
    const indent = indentAt(this.file.getFullText(), start);
    this.edits.push({ start, end: start, text: `${markerText(category, message)}\n${indent}` });
  }
}
