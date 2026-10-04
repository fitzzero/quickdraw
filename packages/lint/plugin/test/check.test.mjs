// The shipped configs' path overrides wherever oxlint runs, and
// `quickdraw-lint check`, which applies the baseline to every rule (oxlint's
// own too), under the oxlint CLI, in a temporary app laid out like the
// quickdraw template (./app.mjs).

import { spawnSync } from "node:child_process";
import path from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import {
  BIN,
  LINT,
  app,
  baseline,
  createApp,
  lintAll,
  read,
  removeApps,
  roots,
  service,
  writeFiles,
} from "./app.mjs";

afterAll(removeApps);

describe("the base config's path overrides", () => {
  // The template lints per package (`oxlint -c ../../.oxlintrc.json src`),
  // so the overrides must match from a package directory as from the root.
  const longFunction = `export function long(): number {\n  let total = 0;\n${"  total += 1;\n".repeat(85)}  return total;\n}\n`;
  const files = [
    ["packages/shared/src/util.ts", "export function shared() {\n  return 1;\n}\n"],
    ["apps/api/src/util.ts", "export function api() {\n  return 1;\n}\n"],
    ["apps/web/src/long.ts", longFunction],
    ["apps/api/src/long.ts", longFunction],
  ];
  const returnType = "typescript-eslint(explicit-function-return-type)";
  const tooLong = "eslint(max-lines-per-function)";

  it.each([
    [".", ["packages/shared/src", "apps/api/src", "apps/web/src"]],
    ["packages/shared", ["src"]],
    ["apps/api", ["src"]],
    ["apps/web", ["src"]],
  ])("apply when oxlint runs from %s", (from, paths) => {
    const root = createApp();
    roots.push(root);
    writeFiles(root, files);
    const found = lintAll(root, path.join(root, from), paths);
    const of = (code) =>
      found.filter((entry) => entry.startsWith(`${code} `)).map((entry) => entry.split(" ")[1]);
    // shared and db export their types: explicit return types there only
    expect(of(returnType)).toEqual(
      from === "." || from === "packages/shared" ? ["packages/shared/src/util.ts:1"] : [],
    );
    // the web app's files have no size budget, a .ts file too
    expect(of(tooLong)).toEqual(
      from === "." || from === "apps/api" ? ["apps/api/src/long.ts:1"] : [],
    );
  });
});

const CHECK = (cwd, args = []) => {
  const result = spawnSync(process.execPath, [BIN, "check", ...args], { cwd, encoding: "utf8" });
  return { status: result.status, stdout: result.stdout, stderr: result.stderr };
};

describe("quickdraw-lint check", () => {
  // oxlint's own no-unused-vars, beside the quickdraw rule no-unbounded-read
  const unused = (name) => `export function ${name}(): void {\n  const ${name}Left = 1;\n}\n`;

  it("applies the baseline to oxlint's own rules too, and reports what is new", () => {
    const root = app();
    writeFiles(root, [[service, read("task") + unused("first")]]);
    expect(CHECK(root).status).toBe(1);
    const { output, file } = baseline(root);
    expect(output).toBe("Wrote 2 violation(s) in 1 file(s) to .quickdraw-lint-baseline.json\n");
    expect(Object.keys(file.files[service]).toSorted()).toEqual([
      "eslint(no-unused-vars)",
      "no-unbounded-read",
    ]);
    expect(CHECK(root)).toEqual({
      status: 0,
      stdout: "Found 0 warnings and 0 errors.\n",
      stderr: "",
    });
    // plain oxlint applies the baseline to the quickdraw rules only
    expect(lintAll(root, root)).toEqual([`eslint(no-unused-vars) ${service}:3`]);

    // a new violation of the same rule is reported at its line
    writeFiles(root, [[service, read("task") + unused("first") + unused("second")]]);
    const added = CHECK(root);
    expect(added.status).toBe(1);
    expect(added.stdout).toContain(
      `${service}:6:9: Variable 'secondLeft' is declared but never used.`,
    );
    expect(added.stdout).toContain("[Error/eslint(no-unused-vars)]");
    expect(added.stdout).not.toContain("firstLeft");
    expect(added.stdout).toMatch(/Found 0 warnings and 1 errors\.\n$/u);
  });

  it("reports an allowance of oxlint's own rules no violation uses, as no-unused-baseline does", () => {
    const root = app();
    writeFiles(root, [[service, read("task") + unused("first")]]);
    baseline(root);
    writeFiles(root, [[service, read("task")]]);
    const result = CHECK(root, ["--format", "json"]);
    expect(result.status).toBe(0);
    const { diagnostics } = JSON.parse(result.stdout);
    expect(diagnostics).toEqual([
      expect.objectContaining({
        code: "quickdraw(no-unused-baseline)",
        severity: "warning",
        filename: service,
        message: expect.stringMatching(/allows 1 `eslint\(no-unused-vars\)` violation/u),
      }),
    ]);
    expect(CHECK(root, ["--deny-warnings"]).status).toBe(1);
    baseline(root);
    expect(CHECK(root, ["--deny-warnings"]).status).toBe(0);
  });

  it("finds the root's baseline from a package directory, through the config's settings", () => {
    const root = app();
    writeFiles(root, [[service, read("task") + unused("first")]]);
    baseline(root);
    const api = path.join(root, "apps", "api");
    expect(CHECK(api, ["-c", "../../.oxlintrc.json", "src"]).status).toBe(0);
    writeFiles(root, [[service, read("task") + unused("first") + unused("second")]]);
    const result = CHECK(api, ["-c", "../../.oxlintrc.json", "src"]);
    expect(result.status).toBe(1);
    expect(result.stdout).toContain("src/services/task.ts:6:9");
  });

  it("always reports a file oxlint cannot parse: no baseline holds a syntax error", () => {
    const root = app();
    writeFiles(root, [[service, "export function broken(): void {\n  super.go();\n}\n"]]);
    expect(baseline(root).output).toBe(
      "Wrote 0 violation(s) in 0 file(s) to .quickdraw-lint-baseline.json\n",
    );
    const result = CHECK(root);
    expect(result.status).toBe(1);
    expect(result.stdout).toContain(`${service}:2:3: 'super' can only be referenced`);
    expect(result.stdout).toContain("[Error/parse error]");
  });

  it("explains itself, and refuses a format it does not write", () => {
    expect(CHECK(LINT, ["--help"]).stdout).toMatch(/^Usage: quickdraw-lint check/u);
    const refused = CHECK(LINT, ["--format", "stylish"]);
    expect(refused.status).toBe(2);
    expect(refused.stderr).toContain('unknown format "stylish"');
  });
});
