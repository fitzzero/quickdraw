// Disable directives, as oxlint applies them, for the baseline wrapper. oxlint
// drops a report that a directive covers after the rule has run, so the
// wrapper cannot see that happen; it reads the directives itself, so that a
// covered report neither uses up an allowance nor counts as a violation
// (`quickdraw-lint baseline` never sees it either).
//
// Recognized as oxlint recognizes them: `oxlint-` or `eslint-` followed by
// `disable`, `enable`, `disable-line` or `disable-next-line`, in a line or a
// block comment, then an optional comma-separated rule list (none means every
// rule) and an optional ` -- reason`. A rule is named `<plugin>/<rule>` or
// `@<plugin>/<rule>`; a bare rule name does not match a plugin's rule.

const DIRECTIVE =
  /^(?:eslint|oxlint)-(disable-next-line|disable-line|disable|enable)(?:\s+(.*))?$/su;

/** The directive a comment holds: `{ kind, rules }` (`rules` null for every rule), or null. */
function parseDirective(comment) {
  const [text] = comment.value.trim().split(/\s-{2,}\s/u);
  const match = DIRECTIVE.exec(text.trim());
  if (match === null) {
    return null;
  }
  const rules = (match[2] ?? "")
    .split(",")
    .map((name) => name.trim())
    .filter((name) => name !== "");
  return { kind: match[1], rules: rules.length === 0 ? null : rules };
}

function names(directive, id) {
  return (
    directive.rules === null || directive.rules.includes(id) || directive.rules.includes(`@${id}`)
  );
}

/**
 * The directives in a file, read once: `covers(id, offset, line)` tells
 * whether the rule `id` (`quickdraw/no-unbounded-read`) is disabled for a
 * report starting at `offset`, on `line` (1-based, as `lineOf` counts).
 */
export function directivesOf(sourceCode, lineOf) {
  const lines = [];
  const ranges = [];
  for (const comment of sourceCode.getAllComments()) {
    const directive = parseDirective(comment);
    if (directive === null) {
      continue;
    }
    const [start, end] = comment.range;
    if (directive.kind === "disable-line") {
      lines.push({ ...directive, line: lineOf(start) });
    } else if (directive.kind === "disable-next-line") {
      lines.push({ ...directive, line: lineOf(end) + 1 });
    } else {
      ranges.push({ ...directive, offset: end });
    }
  }
  return {
    covers(id, offset, line) {
      if (lines.some((directive) => directive.line === line && names(directive, id))) {
        return true;
      }
      let disabled = false;
      for (const directive of ranges) {
        if (directive.offset > offset) {
          break;
        }
        if (names(directive, id)) {
          disabled = directive.kind === "disable";
        }
      }
      return disabled;
    },
  };
}
