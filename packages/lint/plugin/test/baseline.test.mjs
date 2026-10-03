// Baselines, in process: the plugin's rules read a baseline file through the
// `baseline` option or `settings.quickdraw.baseline` (see ../baseline.mjs).
// The command that writes the file is tested against the oxlint CLI in
// oxlint.test.mjs.

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll } from "vitest";
import { BASELINE_ENV, BASELINE_FILE } from "../baseline.mjs";
import { SERVICE, run } from "./tester.mjs";

const root = fs.mkdtempSync(path.join(os.tmpdir(), "quickdraw-lint-baseline-"));
afterAll(() => fs.rmSync(root, { recursive: true, force: true }));

fs.writeFileSync(
  path.join(root, BASELINE_FILE),
  JSON.stringify({ version: 1, files: { [SERVICE]: { "no-unbounded-read": 2 } } }),
);
fs.mkdirSync(path.join(root, "custom"));
fs.writeFileSync(
  path.join(root, "custom", "counts.json"),
  JSON.stringify({ version: 1, files: { [`../${SERVICE}`]: { "no-unbounded-read": 1 } } }),
);

const read = (model) => `export const read${model} = ({ db }) => db.${model}.findMany();\n`;
const TWO = read("task") + read("project");
const THREE = TWO + read("label");
const OPTION = [{ baseline: BASELINE_FILE }];
const filename = path.join(root, SERVICE);

run("no-unbounded-read", {
  valid: [
    {
      name: "two violations and a baseline of two report nothing",
      cwd: root,
      filename,
      options: OPTION,
      code: TWO,
    },
    {
      name: "settings.quickdraw.baseline gives every rule the file",
      cwd: root,
      filename,
      settings: { quickdraw: { baseline: BASELINE_FILE } },
      code: TWO,
    },
    {
      name: "the file is found from the linted file's directory upwards, wherever oxlint runs",
      cwd: path.join(root, "apps", "api"),
      filename,
      options: OPTION,
      code: TWO,
    },
    {
      name: "fewer violations than the baseline counts",
      cwd: root,
      filename,
      options: OPTION,
      code: read("task"),
    },
  ],
  invalid: [
    {
      name: "a third violation reports one, the last",
      cwd: root,
      filename,
      options: OPTION,
      code: THREE,
      errors: [{ messageId: "unbounded", line: 3 }],
    },
    {
      name: "without the option every violation reports",
      cwd: root,
      filename,
      code: TWO,
      errors: [{ messageId: "unbounded" }, { messageId: "unbounded" }],
    },
    {
      name: "a file the baseline does not list",
      cwd: root,
      filename: path.join(root, "apps/api/src/services/project.ts"),
      options: OPTION,
      code: read("task"),
      errors: [{ messageId: "unbounded" }],
    },
    {
      name: "a baseline at another path, its keys relative to it",
      cwd: root,
      filename,
      options: [{ baseline: path.join(root, "custom", "counts.json") }],
      code: TWO,
      errors: [{ messageId: "unbounded", line: 2 }],
    },
    {
      name: `${BASELINE_ENV}=ignore reports everything, for the baseline command`,
      cwd: root,
      filename,
      options: OPTION,
      code: TWO,
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
      name: "the counts are per rule: another rule in a baselined file still reports",
      cwd: root,
      filename,
      options: OPTION,
      code: `db.task.create({ data: { labels: { create: [] } } });`,
      errors: [{ messageId: "nestedWrite" }],
    },
  ],
});
