// `quickdraw-lint check`: runs oxlint and reports only the violations the
// baseline does not record, for every rule. The quickdraw rules apply the
// baseline themselves (`../plugin/baseline.mjs`), so a plain oxlint run, an
// editor's included, already leaves their recorded violations out; oxlint's
// native rules (`no-unused-vars`, `no-shadow`, ...) cannot be wrapped by a JS
// plugin, so this command applies the file to them after oxlint has run:
// each of their diagnostics whose fingerprint the file records is dropped,
// fingerprints counted as the rules count them. It reports what the file
// allows them that no longer occurs as `no-unused-baseline` warnings, the way
// that rule does for the quickdraw rules, so the file only shrinks.
//
// Everything but its own options goes to oxlint unchanged (`-c`, `--fix`,
// `--type-aware`, paths, ...). The baseline file is `--baseline`, else the
// config's `settings.quickdraw.baseline` (the `-c` file, or `.oxlintrc.json`
// here), looked up from each linted file's directory upwards like the rules
// do; without either, nothing is dropped. A file oxlint cannot parse is
// always reported.

import fs from "node:fs";
import path from "node:path";
import {
  PLUGIN,
  UNUSED_RULE,
  baselineKey,
  fingerprint,
  isPluginKey,
  locateBaseline,
  readBaseline,
  sourceLines,
} from "../plugin/baseline.mjs";
import { findOxlint, runOxlint } from "./baseline.mjs";

export const USAGE = `Usage: quickdraw-lint check [options] [oxlint options] [paths...]

Runs oxlint (with the app's config) and reports only the violations the
baseline file does not record, for every rule: the quickdraw rules apply it
themselves, and this applies it to oxlint's own rules too. Allowances that
no violation uses any more are reported as no-unused-baseline warnings.
Exits 1 when an error remains. Use it as the app's lint command.

Options:
      --baseline <file>     baseline file, from here (default: the config's settings.quickdraw.baseline)
  -f, --format <format>     default or json (oxlint's JSON report, filtered)
      --quiet               report errors only
      --deny-warnings       exit 1 when a warning remains
      --max-warnings <n>    exit 1 when more than n warnings remain
      --plugin <name>       the name the quickdraw plugin is loaded under (default: quickdraw)
  -h, --help                show this help

Every other option and every path goes to oxlint as given (-c, --fix, ...).
`;

/** oxlint's options that take a value, so the value is not taken for a path. */
const OXLINT_VALUE_OPTIONS = new Set([
  "-c",
  "--config",
  "--tsconfig",
  "-A",
  "--allow",
  "-W",
  "--warn",
  "-D",
  "--deny",
  "--ignore-path",
  "--ignore-pattern",
  "--threads",
  "--report-unused-disable-directives-severity",
]);

/** The extensions oxlint lints, for telling which recorded files a run covered. */
const LINTED = /\.(?:[cm]?[jt]sx?|vue|svelte|astro)$/u;

class UsageError extends Error {}

/** This command's own options: what each does with its value (`undefined` for a flag). */
const OWN_OPTIONS = {
  "--baseline": (options, value) => {
    options.baseline = value;
  },
  "--format": (options, value) => {
    if (value !== "default" && value !== "json") {
      throw new UsageError(`unknown format "${value}": use default or json`);
    }
    options.format = value;
  },
  "--quiet": (options) => {
    options.quiet = true;
  },
  "--deny-warnings": (options) => {
    options.denyWarnings = true;
  },
  "--max-warnings": (options, value) => {
    options.maxWarnings = Number(value);
    if (!Number.isInteger(options.maxWarnings) || options.maxWarnings < 0) {
      throw new UsageError("--max-warnings needs a whole number");
    }
  },
  "--plugin": (options, value) => {
    options.plugin = value;
  },
  "--help": (options) => {
    options.help = true;
  },
};
const ALIASES = { "-f": "--format", "-h": "--help" };
const FLAGS = new Set(["--quiet", "--deny-warnings", "--help"]);

/** Splits the arguments into this command's options and oxlint's. */
export function parseCheckArgs(args) {
  const options = {
    baseline: undefined,
    format: "default",
    quiet: false,
    denyWarnings: false,
    maxWarnings: undefined,
    plugin: PLUGIN,
    help: false,
    config: undefined,
    oxlint: [],
    paths: [],
  };
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    const [given, inline] =
      arg.startsWith("--") && arg.includes("=") ? arg.split(/=(.*)/su) : [arg];
    const flag = Object.hasOwn(ALIASES, given) ? ALIASES[given] : given;
    const own = Object.hasOwn(OWN_OPTIONS, flag) ? OWN_OPTIONS[flag] : undefined;
    const takesValue = (own !== undefined && !FLAGS.has(flag)) || OXLINT_VALUE_OPTIONS.has(flag);
    let value = inline;
    if (takesValue && value === undefined) {
      value = args[index + 1];
      if (value === undefined || value.startsWith("-")) {
        throw new UsageError(`${given} needs a value`);
      }
      index += 1;
    }
    if (own !== undefined) {
      own(options, value);
    } else if (takesValue) {
      options.oxlint.push(flag, value);
      options.config = flag === "-c" || flag === "--config" ? value : options.config;
    } else if (arg.startsWith("-")) {
      options.oxlint.push(arg);
    } else {
      options.paths.push(arg);
    }
  }
  return options;
}

/** JSON with comments and trailing commas (an oxlint config) parsed, or `undefined`. */
export function readJsonc(file) {
  let text;
  try {
    text = fs.readFileSync(file, "utf8");
  } catch {
    return undefined;
  }
  let out = "";
  for (let index = 0; index < text.length; index += 1) {
    const char = text[index];
    if (char === '"') {
      const end = endOfString(text, index);
      out += text.slice(index, end);
      index = end - 1;
    } else if (char === "/" && text[index + 1] === "/") {
      const end = text.indexOf("\n", index);
      index = (end === -1 ? text.length : end) - 1;
    } else if (char === "/" && text[index + 1] === "*") {
      const end = text.indexOf("*/", index + 2);
      index = (end === -1 ? text.length : end + 2) - 1;
    } else {
      out += char;
    }
  }
  try {
    return JSON.parse(out.replace(/,(\s*[}\]])/gu, "$1"));
  } catch {
    return undefined;
  }
}

function endOfString(text, start) {
  let index = start + 1;
  while (index < text.length && text[index] !== '"') {
    index += text[index] === "\\" ? 2 : 1;
  }
  return index + 1;
}

/**
 * The baseline file's name: the option (a path from the current directory),
 * else the config's `settings.quickdraw.baseline` (looked up from each
 * linted file's directory upwards, as the rules look it up).
 */
function baselineName(options, cwd) {
  if (options.baseline !== undefined) {
    return path.resolve(cwd, options.baseline);
  }
  const config = path.resolve(cwd, options.config ?? ".oxlintrc.json");
  const name = readJsonc(config)?.settings?.quickdraw?.baseline;
  return typeof name === "string" && name !== "" ? name : undefined;
}

/** `map.get(key)`, set to `create()` first when missing. */
function entry(map, key, create) {
  if (!map.has(key)) {
    map.set(key, create());
  }
  return map.get(key);
}

const severityOf = (diagnostic) => (diagnostic.severity === "error" ? "error" : "warning");

/**
 * The baselines a run reads, each with what its allowances for oxlint's own
 * rules have left: `{ file, recorded, left: Map<fileKey, Map<rule, Map<print, count>>> }`.
 */
function createLedger(name) {
  const baselines = new Map();
  return {
    baselines,
    /** The baseline serving `absolute` (a file or a directory's file), or `null`. */
    of(directory) {
      const file = name === undefined ? null : locateBaseline(name, directory);
      if (file === null) {
        return null;
      }
      return entry(baselines, file, () => ({
        file,
        recorded: readBaseline(file),
        left: new Map(),
      }));
    },
  };
}

/** What `baseline` still allows `rule` in `fileKey`, copied from the file the first time. */
function allowancesLeft(baseline, fileKey, rule) {
  const rules = entry(baseline.left, fileKey, () => new Map());
  return entry(
    rules,
    rule,
    () =>
      new Map(
        Object.entries(baseline.recorded[fileKey]?.[rule] ?? {}).filter(
          ([, count]) => Number.isInteger(count) && count > 0,
        ),
      ),
  );
}

/** The unused allowances of oxlint's own rules in the files the run linted, as warnings. */
function unusedDiagnostics(ledger, { cwd, roots, plugin }) {
  const found = [];
  const covered = (absolute) =>
    LINTED.test(absolute) &&
    roots.some((root) => absolute === root || absolute.startsWith(`${root}${path.sep}`)) &&
    fs.existsSync(absolute);
  for (const baseline of ledger.baselines.values()) {
    const directory = path.dirname(baseline.file);
    for (const [fileKey, rules] of Object.entries(baseline.recorded)) {
      const absolute = path.resolve(directory, fileKey);
      if (!covered(absolute)) {
        continue;
      }
      for (const rule of Object.keys(rules)
        .filter((key) => !isPluginKey(key))
        .toSorted()) {
        let count = 0;
        for (const left of allowancesLeft(baseline, fileKey, rule).values()) {
          count += left;
        }
        if (count > 0) {
          found.push({
            message: `The baseline allows ${count} \`${rule}\` violation(s) in this file that no longer occur. Run \`quickdraw-lint baseline\` again so a new violation cannot take their place.`,
            code: `${plugin}(${UNUSED_RULE})`,
            severity: "warning",
            filename: path.relative(cwd, absolute),
            labels: [{ span: { offset: 0, length: 0, line: 1, column: 1 } }],
          });
        }
      }
    }
  }
  return found;
}

/**
 * Runs oxlint with `options` (from `parseCheckArgs`) and applies the
 * baseline: returns the diagnostics left (oxlint's JSON shape) and how many
 * of the rules it applies the baseline to (all but the quickdraw rules,
 * which leave theirs out themselves) the baseline allowed.
 */
export function check(options, { cwd = process.cwd(), oxlint = findOxlint(cwd) } = {}) {
  const report = runOxlint({
    cwd,
    args: options.oxlint,
    paths: options.paths,
    oxlint,
    ignoreBaselines: false,
  });
  const ledger = createLedger(baselineName(options, cwd));
  const sources = new Map();
  const diagnostics = [...(report.diagnostics ?? [])].toSorted(
    (a, b) =>
      a.filename.localeCompare(b.filename) ||
      (a.labels?.[0]?.span?.offset ?? 0) - (b.labels?.[0]?.span?.offset ?? 0),
  );
  const kept = [];
  let allowed = 0;
  for (const diagnostic of diagnostics) {
    const rule = baselineKey(diagnostic.code, options.plugin);
    const absolute = path.resolve(cwd, diagnostic.filename);
    const baseline = rule === null || isPluginKey(rule) ? null : ledger.of(path.dirname(absolute));
    if (baseline === null) {
      kept.push(diagnostic);
      continue;
    }
    const lines = entry(sources, absolute, () => sourceLines(fs.readFileSync(absolute, "utf8")));
    const print = fingerprint(lines.text(diagnostic.labels?.[0]?.span?.line ?? 1));
    const fileKey = path.relative(path.dirname(baseline.file), absolute).split(path.sep).join("/");
    const left = allowancesLeft(baseline, fileKey, rule);
    if ((left.get(print) ?? 0) > 0) {
      left.set(print, left.get(print) - 1);
      allowed += 1;
    } else {
      kept.push(diagnostic);
    }
  }
  const roots = (options.paths.length === 0 ? ["."] : options.paths).map((p) =>
    path.resolve(cwd, p),
  );
  for (const root of roots) {
    ledger.of(fs.existsSync(root) && fs.statSync(root).isDirectory() ? root : path.dirname(root));
  }
  kept.push(...unusedDiagnostics(ledger, { cwd, roots, plugin: options.plugin }));
  return { diagnostics: kept, allowed };
}

function line(diagnostic) {
  const span = diagnostic.labels?.[0]?.span;
  const severity = severityOf(diagnostic) === "error" ? "Error" : "Warning";
  const code = typeof diagnostic.code === "string" ? diagnostic.code : "parse error";
  const help = typeof diagnostic.help === "string" ? `\n  help: ${diagnostic.help}` : "";
  return `${diagnostic.filename}:${String(span?.line ?? 1)}:${String(span?.column ?? 1)}: ${diagnostic.message} [${severity}/${code}]${help}`;
}

/** The `check` command: returns the process exit code. */
export function main(
  args,
  { cwd = process.cwd(), stdout = process.stdout, stderr = process.stderr, oxlint } = {},
) {
  let options;
  try {
    options = parseCheckArgs(args);
  } catch (error) {
    if (error instanceof UsageError) {
      stderr.write(`quickdraw-lint check: ${error.message}\n\n${USAGE}`);
      return 2;
    }
    throw error;
  }
  if (options.help) {
    stdout.write(USAGE);
    return 0;
  }
  let result;
  try {
    result = check(options, { cwd, ...(oxlint === undefined ? {} : { oxlint }) });
  } catch (error) {
    stderr.write(`quickdraw-lint check: ${error.message}\n`);
    return 1;
  }
  const shown = options.quiet
    ? result.diagnostics.filter((diagnostic) => severityOf(diagnostic) === "error")
    : result.diagnostics;
  const errors = result.diagnostics.filter((d) => severityOf(d) === "error").length;
  const warnings = result.diagnostics.length - errors;
  if (options.format === "json") {
    stdout.write(`${JSON.stringify({ diagnostics: shown, allowed: result.allowed }, null, 2)}\n`);
  } else {
    stdout.write(
      [
        ...shown.map((diagnostic) => line(diagnostic)),
        ...(shown.length === 0 ? [] : [""]),
        `Found ${String(warnings)} warnings and ${String(errors)} errors.`,
        "",
      ].join("\n"),
    );
  }
  const tooManyWarnings =
    (options.denyWarnings && warnings > 0) ||
    (options.maxWarnings !== undefined && warnings > options.maxWarnings);
  return errors > 0 || tooManyWarnings ? 1 : 0;
}
