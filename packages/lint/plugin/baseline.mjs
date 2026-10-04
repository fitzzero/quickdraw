// Baselines (RFC 0003 section 14): an app adopts a rule without fixing the
// code it already reports. `quickdraw-lint baseline` records a fingerprint
// for every violation it finds: the rule, the file, and a hash of the
// violating line's trimmed text. A rule given that file reports a violation
// only when its fingerprint is not recorded (or is recorded fewer times than
// it now occurs), so fixing one violation and adding another in the same file
// reports the new one, at its own line. Edits elsewhere in the file move
// lines without changing their text, so they disturb nothing.
//
// The wrapper and the command count the same reports: a report that a
// disable directive covers is dropped by oxlint, so the command never records
// it, and the wrapper passes it on without using an allowance. An allowance
// no violation uses any more is reported by `no-unused-baseline` (a warning
// in the base config), so the file ratchets down when the command runs again.
//
// Every rule takes `{ "baseline": "<path>" }`; `settings.quickdraw.baseline`
// in the app's own oxlint config sets it for every rule at once. A relative
// path is looked up from the linted file's directory upwards, so one file at
// the repository root serves lint runs started from any package directory.
// Its keys are paths relative to the directory holding it.
//
// File format (version 2; version 1 held counts per file and is refused):
//   { "version": 2, "files": { "apps/api/src/services/task.ts": {
//       "no-unbounded-read": { "<fingerprint>": 1 } } } }

import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { directivesOf } from "./lib/directives.mjs";

/** The baseline file's default name. */
export const BASELINE_FILE = ".quickdraw-lint-baseline.json";

/** The baseline file format's version. */
export const BASELINE_VERSION = 2;

/**
 * Set to `ignore` to make every rule report everything, whatever its
 * baseline says; `quickdraw-lint baseline` runs oxlint this way.
 */
export const BASELINE_ENV = "QUICKDRAW_LINT_BASELINE";

/** The rule that reports allowances no violation uses (`rules/no-unused-baseline.mjs`). */
export const UNUSED_RULE = "no-unused-baseline";

const BASELINE_OPTION = Object.freeze({
  type: "string",
  description:
    "Path of a baseline file written by `quickdraw-lint baseline`: the violations it records are not reported.",
});

const LINE_BREAK = /\r\n|\r|\n/gu;

/**
 * The lines of `text`, numbered as oxlint numbers them in its reports (line
 * breaks are `\r\n`, `\r` and `\n`): `lineOf(offset)` is the 1-based line
 * holding a character offset, `text(line)` that line's text.
 */
export function sourceLines(text) {
  const starts = [0];
  for (const match of text.matchAll(LINE_BREAK)) {
    starts.push(match.index + match[0].length);
  }
  return {
    lineOf(offset) {
      let low = 0;
      let high = starts.length - 1;
      while (low < high) {
        const middle = (low + high + 1) >> 1;
        if (starts[middle] <= offset) {
          low = middle;
        } else {
          high = middle - 1;
        }
      }
      return low + 1;
    },
    text(line) {
      const start = starts[line - 1];
      if (start === undefined) {
        return "";
      }
      const end = starts[line] ?? text.length;
      return text.slice(start, end).replace(/(?:\r\n|\r|\n)$/u, "");
    },
  };
}

/** A violation's fingerprint within its file and rule: a hash of its line's trimmed text. */
export function fingerprint(lineText) {
  return crypto.createHash("sha256").update(lineText.trim()).digest("hex").slice(0, 16);
}

const located = new Map();
const parsed = new Map();

/** The baseline file `name` resolves to for a file in `directory`, or `null`. */
function locate(name, directory) {
  if (path.isAbsolute(name)) {
    return fs.existsSync(name) ? name : null;
  }
  const key = `${directory}\0${name}`;
  if (located.has(key)) {
    return located.get(key);
  }
  const candidate = path.join(directory, name);
  const parent = path.dirname(directory);
  let found = null;
  if (fs.existsSync(candidate)) {
    found = candidate;
  } else if (parent !== directory) {
    found = locate(name, parent);
  }
  located.set(key, found);
  return found;
}

/** The fingerprints in the baseline file at `file`, read once per lint run. */
export function readBaseline(file) {
  if (!parsed.has(file)) {
    let data;
    try {
      data = JSON.parse(fs.readFileSync(file, "utf8"));
    } catch (error) {
      throw new Error(`quickdraw-lint: cannot read the baseline file ${file}: ${error.message}`, {
        cause: error,
      });
    }
    if (data?.version === 1) {
      throw new Error(
        `quickdraw-lint: ${file} is a version 1 baseline, which counted violations per file; this quickdraw-lint records each violation's fingerprint (version ${BASELINE_VERSION}). Write it again with \`quickdraw-lint baseline\``,
      );
    }
    if (
      data?.version !== BASELINE_VERSION ||
      typeof data.files !== "object" ||
      data.files === null
    ) {
      throw new Error(
        `quickdraw-lint: ${file} is not a version ${BASELINE_VERSION} baseline file; write it again with \`quickdraw-lint baseline\``,
      );
    }
    parsed.set(file, data.files);
  }
  return parsed.get(file);
}

/** The rule's name without its plugin's: `quickdraw/no-unbounded-read` gives `no-unbounded-read`. */
export function ruleName(context) {
  return context.id.slice(context.id.lastIndexOf("/") + 1);
}

/**
 * The violations of this rule the baseline allows in the linted file, as a
 * map from fingerprint to how many times it may occur, or `null` when there
 * are none.
 */
function allowances(context) {
  if (process.env[BASELINE_ENV] === "ignore") {
    return null;
  }
  const name = context.options[0]?.baseline ?? context.settings?.quickdraw?.baseline;
  if (typeof name !== "string" || name === "") {
    return null;
  }
  const file = locate(name, path.dirname(context.filename));
  if (file === null) {
    return null;
  }
  const key = path.relative(path.dirname(file), context.filename).split(path.sep).join("/");
  const recorded = readBaseline(file)[key]?.[ruleName(context)];
  const allowed = new Map(
    Object.entries(recorded ?? {}).filter(([, count]) => Number.isInteger(count) && count > 0),
  );
  return allowed.size === 0 ? null : allowed;
}

/** `schema` with the `baseline` option added to the rule's options object. */
function withBaselineOption(schema) {
  const [first, ...rest] = Array.isArray(schema) ? schema : [];
  const options = first ?? { type: "object", properties: {}, additionalProperties: false };
  return [
    { ...options, properties: { ...options.properties, baseline: BASELINE_OPTION } },
    ...rest,
  ];
}

// The allowances left unused in the file being linted, per rule, for
// `no-unused-baseline`. oxlint lints one file at a time per thread and runs
// that rule's `after` hook once every rule's `Program:exit` has run, so one
// file's worth is all this ever holds.
let unused = { filename: null, rules: [] };

function recordUnused(context, allowed) {
  let count = 0;
  for (const left of allowed.values()) {
    count += left;
  }
  if (unused.filename !== context.filename) {
    unused = { filename: context.filename, rules: [] };
  }
  if (count > 0) {
    unused.rules.push({ rule: ruleName(context), count });
  }
}

/**
 * The allowances the baseline holds for `filename` that its violations left
 * unused, as `{ rule, count }` per rule that ran; forgets them.
 */
export function takeUnused(filename) {
  const { rules } = unused.filename === filename ? unused : { rules: [] };
  unused = { filename: null, rules: [] };
  return rules;
}

/** Where a report starts, as a character offset. */
function reportStart(context, descriptor) {
  const range = descriptor.node?.range;
  if (range !== undefined) {
    return range[0];
  }
  const { loc } = descriptor;
  return context.sourceCode.getIndexFromLoc(loc.start ?? loc);
}

/**
 * Reports the held reports the baseline does not allow, in source order: a
 * report a directive covers goes to oxlint (which drops it) without using an
 * allowance, a recorded fingerprint uses one, and the rest are reported.
 */
function release(context, held, allowed) {
  if (held.length === 0) {
    recordUnused(context, allowed);
    return;
  }
  const { sourceCode } = context;
  const lines = sourceLines(sourceCode.text);
  const directives = directivesOf(sourceCode, (offset) => lines.lineOf(offset));
  const starts = new Map(held.map((descriptor) => [descriptor, reportStart(context, descriptor)]));
  for (const descriptor of held.toSorted((a, b) => starts.get(a) - starts.get(b))) {
    const line = lines.lineOf(starts.get(descriptor));
    if (directives.covers(context.id, starts.get(descriptor), line)) {
      context.report(descriptor);
      continue;
    }
    const print = fingerprint(lines.text(line));
    const left = allowed.get(print) ?? 0;
    if (left > 0) {
      allowed.set(print, left - 1);
    } else {
      context.report(descriptor);
    }
  }
  recordUnused(context, allowed);
}

/**
 * `rule` with baseline support: the `baseline` option in its schema, and its
 * reports held back until the file is walked, then reported unless the
 * baseline records their fingerprints.
 */
export function withBaseline(rule) {
  return {
    ...rule,
    meta: { ...rule.meta, schema: withBaselineOption(rule.meta.schema) },
    create(context) {
      const allowed = allowances(context);
      if (allowed === null) {
        return rule.create(context);
      }
      const held = [];
      const visitors = rule.create(
        Object.create(context, { report: { value: (descriptor) => held.push(descriptor) } }),
      );
      const exit = visitors["Program:exit"];
      return {
        ...visitors,
        "Program:exit"(node) {
          exit?.(node);
          release(context, held, allowed);
        },
      };
    },
  };
}
