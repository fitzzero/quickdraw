// Baselines (RFC 0003 section 14): an app adopts a rule without fixing the
// code it already reports. `quickdraw-lint baseline` records how many times
// each rule reports in each file; a rule given that file reports nothing in
// a file until the file holds more violations than recorded, and then only
// the ones beyond the count (the last ones in the file).
//
// Every rule takes `{ "baseline": "<path>" }`; `settings.quickdraw.baseline`
// in the app's own oxlint config sets it for every rule at once. A relative
// path is looked up from the linted file's directory upwards, so one file at
// the repository root serves lint runs started from any package directory.
// Its keys are paths relative to the directory holding it.
//
// File format:
//   { "version": 1, "files": { "apps/api/src/services/task.ts": { "no-unbounded-read": 2 } } }

import fs from "node:fs";
import path from "node:path";

/** The baseline file's default name. */
export const BASELINE_FILE = ".quickdraw-lint-baseline.json";

/** The baseline file format's version. */
export const BASELINE_VERSION = 1;

/**
 * Set to `ignore` to make every rule report everything, whatever its
 * baseline says; `quickdraw-lint baseline` runs oxlint this way.
 */
export const BASELINE_ENV = "QUICKDRAW_LINT_BASELINE";

const BASELINE_OPTION = Object.freeze({
  type: "string",
  description:
    "Path of a baseline file written by `quickdraw-lint baseline`: violations it counts are not reported.",
});

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

/** The counts in the baseline file at `file`, read once per lint run. */
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
    if (data?.version !== BASELINE_VERSION || typeof data.files !== "object") {
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

/** How many violations of this rule the baseline allows in the linted file. */
function allowance(context) {
  if (process.env[BASELINE_ENV] === "ignore") {
    return 0;
  }
  const name = context.options[0]?.baseline ?? context.settings?.quickdraw?.baseline;
  if (typeof name !== "string" || name === "") {
    return 0;
  }
  const file = locate(name, path.dirname(context.filename));
  if (file === null) {
    return 0;
  }
  const key = path.relative(path.dirname(file), context.filename).split(path.sep).join("/");
  const count = readBaseline(file)[key]?.[ruleName(context)];
  return Number.isInteger(count) && count > 0 ? count : 0;
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

/**
 * `rule` with baseline support: the `baseline` option in its schema, and its
 * reports held back while the linted file holds no more of them than the
 * baseline counts for it.
 */
export function withBaseline(rule) {
  return {
    ...rule,
    meta: { ...rule.meta, schema: withBaselineOption(rule.meta.schema) },
    create(context) {
      const allowed = allowance(context);
      if (allowed === 0) {
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
          for (const descriptor of held.slice(allowed)) {
            context.report(descriptor);
          }
        },
      };
    },
  };
}
