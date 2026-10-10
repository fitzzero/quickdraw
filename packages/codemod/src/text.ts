// Text edits. The transforms read a file's syntax tree, describe what to
// change as edits at file offsets, and apply them in one pass, so no edit
// invalidates the nodes another edit still refers to.

import { Node } from "ts-morph";

/** Replaces the text between `start` and `end` (file offsets) with `text`. */
export interface Edit {
  readonly start: number;
  readonly end: number;
  readonly text: string;
}

/**
 * `text`, which starts at file offset `base`, with `edits` applied. Edits
 * must not overlap; an insertion (`start === end`) at the start of a
 * replacement lands before the replacement's text.
 */
export function applyEdits(text: string, base: number, edits: readonly Edit[]): string {
  const ordered = withoutContained(edits).toSorted((a, b) => b.start - a.start || b.end - a.end);
  let out = text;
  for (const edit of ordered) {
    out = out.slice(0, edit.start - base) + edit.text + out.slice(edit.end - base);
  }
  return out;
}

/**
 * Drops the edits inside a larger replacement: the replacement's text was
 * computed from the same nodes, so it already says what they would.
 */
function withoutContained(edits: readonly Edit[]): Edit[] {
  const replacements = edits.filter((edit) => edit.end > edit.start);
  const inside = (edit: Edit, outer: Edit): boolean => {
    if (outer === edit) {
      return false;
    }
    if (edit.start === edit.end) {
      return outer.start < edit.start && edit.start < outer.end;
    }
    const contained = outer.start <= edit.start && edit.end <= outer.end;
    const larger = outer.end - outer.start > edit.end - edit.start;
    return contained && (larger || replacements.indexOf(outer) < replacements.indexOf(edit));
  };
  return edits.filter((edit) => !replacements.some((outer) => inside(edit, outer)));
}

/** The text of `node` with `edits` (at file offsets inside it) applied. */
export function editedText(node: Node, edits: readonly Edit[]): string {
  const inside = edits.filter((edit) => edit.start >= node.getStart() && edit.end <= node.getEnd());
  return applyEdits(node.getText(), node.getStart(), inside);
}

/** Whether the line starting at file offset `position` holds only whitespace. */
function blankLineAt(text: string, position: number): boolean {
  const end = text.indexOf("\n", position);
  return end !== -1 && text.slice(position, end).trim() === "";
}

/**
 * An edit removing `node`. A node on lines of its own goes with them, with
 * the comments right above it (no blank line between) and a trailing line
 * comment, and leaves no doubled blank line, nor one at the start or end of
 * its block or file. A node sharing a line with other code goes alone, with
 * the spaces that set it apart.
 */
export function removalEdit(node: Node): Edit {
  const text = node.getSourceFile().getFullText();
  const lineEnd = text.indexOf("\n", node.getEnd());
  const before = text.slice(text.lastIndexOf("\n", node.getStart() - 1) + 1, node.getStart());
  const rest = text.slice(node.getEnd(), lineEnd === -1 ? text.length : lineEnd);
  const firstOnLine = before.trim() === "";
  if (!firstOnLine || !/^[ \t]*(?:\/\/.*)?\r?$/u.test(rest)) {
    const spacesBefore = firstOnLine ? 0 : before.length - before.trimEnd().length;
    const spacesAfter = firstOnLine ? rest.length - rest.trimStart().length : 0;
    return {
      start: node.getStart() - spacesBefore,
      end: node.getEnd() + spacesAfter,
      text: "",
    };
  }
  let first = node.getStart();
  for (const range of node.getLeadingCommentRanges().toReversed()) {
    if (/\n[ \t]*\r?\n/u.test(text.slice(range.getEnd(), first))) {
      break;
    }
    first = range.getPos();
  }
  let start = text.lastIndexOf("\n", first - 1) + 1;
  let end = lineEnd === -1 ? text.length : lineEnd + 1;
  const previousLine = start < 2 ? 0 : text.lastIndexOf("\n", start - 2) + 1;
  const previous = text.slice(previousLine, start).trim();
  const blankBefore = start > 0 && previous === "";
  const opensBlock = start === 0 || previous.endsWith("{");
  const after = text.slice(end).trimStart();
  const closesBlock = after === "" || after.startsWith("}");
  if (blankLineAt(text, end) && (blankBefore || opensBlock)) {
    end = text.indexOf("\n", end) + 1;
  } else if (blankBefore && closesBlock) {
    start = previousLine;
  }
  return { start, end, text: "" };
}

/** The whitespace that starts the line holding file offset `position`. */
export function indentAt(fileText: string, position: number): string {
  const lineStart = fileText.lastIndexOf("\n", position - 1) + 1;
  return /^[ \t]*/u.exec(fileText.slice(lineStart))?.[0] ?? "";
}

/**
 * The statement (or class member, or object property) a node belongs to:
 * where a marker comment about the node goes.
 */
export function statementOf(node: Node): Node {
  let current = node;
  for (;;) {
    const parent = current.getParent();
    if (parent === undefined) {
      return current;
    }
    if (
      Node.isBlock(parent) ||
      Node.isSourceFile(parent) ||
      Node.isCaseClause(parent) ||
      Node.isDefaultClause(parent) ||
      Node.isModuleBlock(parent) ||
      Node.isClassDeclaration(parent) ||
      Node.isObjectLiteralExpression(parent)
    ) {
      return current;
    }
    current = parent;
  }
}

/** `name` with its first letter in lower case: `ChatService` gives `chatService`. */
export function lowerFirst(name: string): string {
  return name.charAt(0).toLowerCase() + name.slice(1);
}

/** `name` with its first letter in upper case. */
export function upperFirst(name: string): string {
  return name.charAt(0).toUpperCase() + name.slice(1);
}

/** `a`, `a and b`, `a, b and c`. */
export function listText(items: readonly string[]): string {
  return items.length < 2
    ? (items[0] ?? "")
    : `${items.slice(0, -1).join(", ")} and ${items.at(-1) ?? ""}`;
}

/** A JavaScript string literal of `value`, in double quotes. */
export function quote(value: string): string {
  return JSON.stringify(value);
}
