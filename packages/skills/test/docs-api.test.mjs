// The docs-on-push workflow the quickdraw-api-docs skill ships
// (skills/quickdraw-api-docs/docs-api.yml). An app copies it into
// .github/workflows, so nothing here can run it; these tests hold its text to
// the skill's rules: a push trigger only, a read-only job that runs the
// dependency code and the docs command, and a job that can write and runs
// nothing but git.

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";

const skillDir = join(
  dirname(fileURLToPath(import.meta.url)),
  "..",
  "skills",
  "quickdraw-api-docs",
);
const workflow = readFileSync(join(skillDir, "docs-api.yml"), "utf8");

/** The lines of a top-level key's block, or of a job's under `jobs:`, comments left out. */
function block(name, indent = "") {
  const lines = workflow.split("\n").filter((line) => !/^\s*#/.test(line));
  const start = lines.indexOf(`${indent}${name}:`);
  assert.notEqual(start, -1, `${indent}${name}: is in the workflow`);
  const end = lines.findIndex(
    (line, index) =>
      index > start &&
      line !== "" &&
      !line.startsWith(`${indent} `) &&
      !line.startsWith(`${indent}  `),
  );
  return lines
    .slice(start + 1, end === -1 ? undefined : end)
    .join("\n")
    .trimEnd();
}

describe("the docs-on-push workflow", () => {
  it("runs on a push to the base branch and by hand, never on pull_request_target", () => {
    const on = block("on");
    assert.match(on, /^ {2}push:\n {4}branches: \[dev\]\n {4}paths:\n/);
    assert.match(on, /^ {2}workflow_dispatch:$/m);
    assert.doesNotMatch(workflow, /pull_request/);
    assert.match(block("concurrency"), /cancel-in-progress: true/);
    assert.equal(block("permissions"), "  contents: read");
  });

  it("generates the pages with a read-only token, and hands them over as an artifact", () => {
    const generate = block("generate", "  ");
    assert.match(generate, /permissions:\n {6}contents: read\n/);
    assert.match(generate, /persist-credentials: false/);
    assert.match(generate, /bun install --frozen-lockfile/);
    assert.match(
      generate,
      /run: bunx quickdraw-docs "\$CONTRACTS" --services "\$SERVICES" --out "\$OUT"/,
    );
    assert.match(generate, /uses: actions\/upload-artifact@v\d+\n {8}with:\n {10}name: docs-api\n/);
    assert.doesNotMatch(generate, /secrets\./);
    assert.doesNotMatch(generate, /contents: write/);
  });

  it("commits them from a job that runs no dependency code", () => {
    const commit = block("commit", "  ");
    assert.match(commit, /needs: generate/);
    assert.match(commit, /permissions:\n {6}contents: write\n/);
    assert.match(commit, /uses: actions\/download-artifact@v\d+\n {8}with:\n {10}name: docs-api\n/);
    assert.match(commit, /git diff --cached --quiet/);
    assert.match(commit, /git push origin "HEAD:\$GITHUB_REF_NAME"/);
    // No install, build or package binary, and no token but GITHUB_TOKEN.
    assert.doesNotMatch(commit, /\b(bun|bunx|npm|npx|pnpm|yarn|node|turbo|quickdraw-docs)\b/);
    assert.doesNotMatch(commit, /secrets\.|token:/);
    const steps = [...commit.matchAll(/^ {6}- (uses|run|name): (.+)$/gm)].map((step) => step[2]);
    assert.deepEqual(
      steps.filter((step) => step.includes("@")),
      ["actions/checkout@v7", "actions/download-artifact@v4"],
    );
  });

  it("is the file the skill tells an app to copy", () => {
    const skill = readFileSync(join(skillDir, "SKILL.md"), "utf8");
    assert.match(skill, /^name: quickdraw-api-docs$/m);
    assert.ok(
      skill.includes(
        "node_modules/@fitzzero/quickdraw-skills/skills/quickdraw-api-docs/docs-api.yml",
      ),
    );
    assert.ok(skill.includes(".github/workflows/docs-api.yml"));
  });
});
