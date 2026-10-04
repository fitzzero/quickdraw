// Baselines, in process: the plugin's rules read a baseline file through the
// `baseline` option or `settings.quickdraw.baseline` (see ../baseline.mjs).
// The command that writes the file, `no-unused-baseline` and disable
// directives are tested against the oxlint CLI in oxlint.test.mjs: oxlint's
// RuleTester runs one rule and applies no directives.

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import {
  BASELINE_ENV,
  BASELINE_FILE,
  fingerprint,
  readBaseline,
  sourceLines,
} from "../baseline.mjs";
import { SERVICE, run } from "./tester.mjs";

const root = fs.mkdtempSync(path.join(os.tmpdir(), "quickdraw-lint-baseline-"));
afterAll(() => fs.rmSync(root, { recursive: true, force: true }));

const read = (model) => `export const read${model} = ({ db }) => db.${model}.findMany();`;
const TASK = read("task");
const PROJECT = read("project");
const LABEL = read("label");
const REPEATED = "void db.task.findMany();";

/** The fingerprints of `lines`, each counted once per occurrence. */
function prints(lines) {
  const counts = {};
  for (const line of lines) {
    const print = fingerprint(line);
    counts[print] = (counts[print] ?? 0) + 1;
  }
  return counts;
}

function write(file, data) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(data));
}

write(path.join(root, BASELINE_FILE), {
  version: 2,
  files: { [SERVICE]: { "no-unbounded-read": prints([TASK, PROJECT, REPEATED, REPEATED]) } },
});
write(path.join(root, "custom", "fingerprints.json"), {
  version: 2,
  files: { [`../${SERVICE}`]: { "no-unbounded-read": prints([TASK]) } },
});
write(path.join(root, "old", BASELINE_FILE), {
  version: 1,
  files: { [SERVICE]: { "no-unbounded-read": 2 } },
});

const OPTION = [{ baseline: BASELINE_FILE }];
const filename = path.join(root, SERVICE);

run("no-unbounded-read", {
  valid: [
    {
      name: "every violation the baseline records reports nothing",
      cwd: root,
      filename,
      options: OPTION,
      code: `${TASK}\n${PROJECT}\n`,
    },
    {
      name: "settings.quickdraw.baseline gives every rule the file",
      cwd: root,
      filename,
      settings: { quickdraw: { baseline: BASELINE_FILE } },
      code: `${TASK}\n${PROJECT}\n`,
    },
    {
      name: "the file is found from the linted file's directory upwards, wherever oxlint runs",
      cwd: path.join(root, "apps", "api"),
      filename,
      options: OPTION,
      code: `${TASK}\n${PROJECT}\n`,
    },
    {
      name: "lines move, are indented or gain neighbors: the fingerprint is the line's trimmed text",
      cwd: root,
      filename,
      options: OPTION,
      code: `// a header\n\n    ${PROJECT}\nexport const unrelated = 1;\n${TASK}\n`,
    },
    {
      name: "a line recorded twice allows two occurrences",
      cwd: root,
      filename,
      options: OPTION,
      code: `${REPEATED}\n${REPEATED}\n`,
    },
  ],
  invalid: [
    {
      name: "the swap: a recorded violation fixed and a new one added reports the new one, at its line",
      cwd: root,
      filename,
      options: OPTION,
      code: `${PROJECT}\n${LABEL}\n`,
      errors: [{ messageId: "unbounded", line: 2 }],
    },
    {
      name: "a recorded line occurring more often than recorded reports the later ones",
      cwd: root,
      filename,
      options: OPTION,
      code: `${REPEATED}\n${REPEATED}\n${REPEATED}\n`,
      errors: [{ messageId: "unbounded", line: 3 }],
    },
    {
      // The RuleTester applies no directives, so the covered report shows here.
      name: "a violation a directive covers goes to oxlint (which drops it) and uses no allowance",
      cwd: root,
      filename,
      options: OPTION,
      code: `// oxlint-disable-next-line\n${REPEATED}\n${REPEATED}\n/* eslint-disable */\n${REPEATED}\n`,
      errors: [
        { messageId: "unbounded", line: 2 },
        { messageId: "unbounded", line: 5 },
      ],
    },
    {
      name: "a directive naming another rule leaves the report to the baseline",
      cwd: root,
      filename,
      options: OPTION,
      code: `${REPEATED}\n// oxlint-disable-next-line quickdraw/no-nested-write -- not this rule\n${REPEATED}\n${REPEATED}\n`,
      errors: [{ messageId: "unbounded", line: 4 }],
    },
    {
      name: "without the option every violation reports",
      cwd: root,
      filename,
      code: `${TASK}\n${PROJECT}\n`,
      errors: [{ messageId: "unbounded" }, { messageId: "unbounded" }],
    },
    {
      name: "a file the baseline does not list",
      cwd: root,
      filename: path.join(root, "apps/api/src/services/project.ts"),
      options: OPTION,
      code: TASK,
      errors: [{ messageId: "unbounded" }],
    },
    {
      name: "a baseline at another path, its keys relative to it",
      cwd: root,
      filename,
      options: [{ baseline: path.join(root, "custom", "fingerprints.json") }],
      code: `${TASK}\n${PROJECT}\n`,
      errors: [{ messageId: "unbounded", line: 2 }],
    },
    {
      name: `${BASELINE_ENV}=ignore reports everything, for the baseline command`,
      cwd: root,
      filename,
      options: OPTION,
      code: `${TASK}\n${PROJECT}\n`,
      before() {
        process.env[BASELINE_ENV] = "ignore";
      },
      after() {
        delete process.env[BASELINE_ENV];
      },
      errors: [{ messageId: "unbounded" }, { messageId: "unbounded" }],
    },
  ],
});

run("no-nested-write", {
  valid: [],
  invalid: [
    {
      name: "the fingerprints are per rule: another rule in a baselined file still reports",
      cwd: root,
      filename,
      options: OPTION,
      code: `db.task.create({ data: { labels: { create: [] } } });`,
      errors: [{ messageId: "nestedWrite" }],
    },
  ],
});

describe("baseline files", () => {
  it("refuses a version 1 file (counts per file) and says how to replace it", () => {
    expect(() => readBaseline(path.join(root, "old", BASELINE_FILE))).toThrow(
      /is a version 1 baseline, which counted violations per file;.*Write it again with `quickdraw-lint baseline`/,
    );
  });

  it("numbers lines as oxlint's reports do: \\r\\n, \\r and \\n break lines, U+2028 does not", () => {
    const lines = sourceLines("a\r\nb\rc\nd e");
    expect([1, 2, 3, 4].map((line) => lines.text(line))).toEqual(["a", "b", "c", "d e"]);
    expect(lines.lineOf(0)).toBe(1);
    expect(lines.lineOf(3)).toBe(2);
    expect(lines.lineOf(5)).toBe(3);
    expect(lines.lineOf(9)).toBe(4);
    expect(lines.text(9)).toBe("");
  });

  it("fingerprints ignore indentation but not the line's text", () => {
    expect(fingerprint("  db.task.findMany();\t")).toBe(fingerprint("db.task.findMany();"));
    expect(fingerprint("db.task.findMany();")).not.toBe(fingerprint("db.label.findMany();"));
    expect(fingerprint("x")).toMatch(/^[0-9a-f]{16}$/);
  });
});
