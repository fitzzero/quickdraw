// Markdown helpers the generators share (`quickdraw-docs` and
// `quickdraw-protocol`). What they write is laid out the way oxfmt and
// Prettier lay out Markdown (aligned tables, one blank line between blocks),
// so formatting a generated file leaves it as it is and `--check` does not
// report formatting as drift.

const WIDE =
  /[ᄀ-ᅟ⺀-꓏가-힣豈-﫿︰-﹏＀-｠￠-￦\u{1f300}-\u{1f64f}\u{1f900}-\u{1f9ff}\u{20000}-\u{3fffd}]/u;

/** How wide a table cell is, as Prettier measures it: wide characters count twice. */
function widthOf(text: string): number {
  let width = 0;
  for (const char of text) {
    width += WIDE.test(char) ? 2 : 1;
  }
  return width;
}

/** A table cell: one line, with its pipes escaped. */
function cell(text: string): string {
  return text.replace(/\s*\n\s*/g, " ").replace(/\|/g, "\\|");
}

/** A Markdown table with its columns aligned. */
export function table(header: readonly string[], rows: readonly (readonly string[])[]): string[] {
  const cells = [header, ...rows].map((row) => header.map((_, column) => cell(row[column] ?? "")));
  const widths = header.map((_, column) =>
    Math.max(3, ...cells.map((row) => widthOf(row[column] ?? ""))),
  );
  const line = (row: readonly string[]): string =>
    `| ${row.map((text, column) => text + " ".repeat((widths[column] ?? 3) - widthOf(text))).join(" | ")} |`;
  const [head = [], ...body] = cells;
  return [
    line(head),
    `| ${widths.map((width) => "-".repeat(width)).join(" | ")} |`,
    ...body.map(line),
  ];
}

/** Inline code, with a longer fence when the text holds a backtick. */
export function code(text: string): string {
  return text.includes("`") ? `\`\` ${text} \`\`` : `\`${text}\``;
}

/** Names as inline code, separated by commas. */
export function list(names: readonly string[]): string {
  return names.map(code).join(", ");
}

/** A paragraph of source text, trimmed line by line. */
export function paragraph(text: string): string {
  return text
    .split("\n")
    .map((line) => line.trim())
    .join("\n")
    .trim();
}

/** One section: a heading and its blocks, each followed by a blank line. */
export function section(
  heading: string,
  blocks: readonly (string | readonly string[])[],
): string[] {
  const lines = [heading, ""];
  for (const block of blocks) {
    lines.push(...(typeof block === "string" ? [block] : block), "");
  }
  return lines;
}
