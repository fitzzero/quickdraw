// An allowance in the baseline file that no violation uses any more: the
// violation was fixed (or its line changed), so the allowance would let a new
// violation with the same line text in. Reported once per rule and file, at
// the top of the file, so running `quickdraw-lint baseline` again lowers the
// file (see `../baseline.mjs`). The base config reports it as a warning.
//
// The other rules record what they left unused when they finish a file; this
// rule reads that in its `after` hook, which oxlint runs once every rule's
// `Program:exit` has run. It takes no baseline of its own.

import { takeUnused } from "../baseline.mjs";

/** @type {import('eslint').Rule.RuleModule} */
export default {
  meta: {
    type: "suggestion",
    docs: {
      description:
        "Report baseline allowances no violation uses any more, so the baseline file only shrinks.",
    },
    messages: {
      unused:
        "The baseline allows {{ count }} `{{ rule }}` violation(s) in this file that no longer occur. " +
        "Run `quickdraw-lint baseline` again so a new violation cannot take their place.",
    },
    schema: [],
  },
  createOnce(context) {
    return {
      // oxlint skips a `createOnce` rule whose visitor is empty.
      Program() {},
      after() {
        for (const { rule, count } of takeUnused(context.filename)) {
          context.report({
            loc: { line: 1, column: 0 },
            messageId: "unused",
            data: { rule, count: String(count) },
          });
        }
      },
    };
  },
};
