// The `quickdraw-codemod` command: its usage, its refusals, and a dry run
// that reports what would change without writing anything. Also checks that
// the codemod's lists of removed 4.x names are the lint rule's.

import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { main, relaunchHeap } from "../src/cli";
import { MOVED_NAMES, PROVIDER_PROPS, REMOVED_ENTRIES, REMOVED_NAMES } from "../src/v4names";
import { copyFixture, readTree, removeCopies, REPO } from "./helpers";

type Table = Readonly<Record<string, string>>;

/** The lint rule's tables, read at run time (the rule ships as plain .mjs, without types). */
async function lintTables(): Promise<{
  REMOVED_NAMES: Table;
  REMOVED_ENTRIES: Table;
  REMOVED_PROVIDER_PROPS: Table;
  MOVED_NAMES: Readonly<Record<string, Table>>;
}> {
  const path = join(REPO, "packages/lint/plugin/rules/no-v4-api.mjs");
  return (await import(path)) as Awaited<ReturnType<typeof lintTables>>;
}

afterAll(() => {
  removeCopies();
});

function run(...argv: string[]): { code: number; out: string; err: string } {
  let out = "";
  let err = "";
  const code = main(argv, {
    out: (text) => {
      out += text;
    },
    err: (text) => {
      err += text;
    },
  });
  return { code, out, err };
}

describe("quickdraw-codemod", () => {
  it("prints its usage", () => {
    const { code, out } = run("--help");
    expect(code).toBe(0);
    expect(out).toMatch(/^Usage: quickdraw-codemod v5 <repo> \[options\]/u);
  });

  it("refuses an unknown transform, a missing root and an unknown option", () => {
    expect(run("v4", ".").err).toMatch(/^quickdraw-codemod: the only transform is v5\n/u);
    expect(run("v5").err).toMatch(/^quickdraw-codemod: name the app's repository root\n/u);
    const unknown = run("v5", ".", "--nope");
    expect(unknown.code).toBe(2);
    expect(unknown.err).toMatch(/Unknown option '--nope'/u);
  });

  it("fails with a message when the app is not laid out like the template", () => {
    const { code, err } = run("v5", "/nowhere");
    expect(code).toBe(1);
    expect(err).toMatch(/no packages\/shared\/src under \/nowhere\. Pass --shared and --api/u);
  });

  it("reports what a dry run would change, and writes nothing", () => {
    const root = copyFixture("cli");
    const before = readTree(root);
    const { code, out } = run("v5", root, "--dry-run");
    expect(code).toBe(0);
    expect(out).toContain("quickdraw-codemod v5 (dry run: nothing written)");
    expect(out).toContain("5 services, 25 methods (2 aggregator functions removed), 5 contracts");
    expect(out).toContain("  A packages/shared/src/contracts/project.ts");
    expect(out).toContain("  D apps/api/src/services/task/methods/index.ts");
    expect(out).toContain("  D apps/web/src/hooks/useService.ts");
    // The report does not exist yet: the run would create it.
    expect(out).toContain("  A quickdraw-migration-report.md");
    expect(out).not.toContain("  M quickdraw-migration-report.md");
    expect(readTree(root)).toEqual(before);
  });

  it("refuses a --heap that is not a whole number of MiB", () => {
    const { code, err } = run("v5", ".", "--heap", "1.5");
    expect(code).toBe(2);
    expect(err).toMatch(/^quickdraw-codemod: --heap takes a whole number of MiB, 256 or more\n/u);
    expect(run("v5", ".", "--heap", "64").code).toBe(2);
  });

  it("runs a small app in this process, and starts again for --heap", () => {
    const root = copyFixture("cli-heap");
    expect(relaunchHeap(["v5", root, "--dry-run"])).toBeUndefined();
    expect(relaunchHeap(["v5", root, "--heap", "4096"])).toEqual({ heap: 4096, files: 40 });
    // main reports these
    expect(relaunchHeap(["--help"])).toBeUndefined();
    expect(relaunchHeap(["v5", "/nowhere", "--heap", "4096"])).toBeUndefined();
    expect(relaunchHeap(["v5", root, "--heap", "x"])).toBeUndefined();
  });
});

describe("the removed 4.x names", () => {
  it("are the lint rule no-v4-api's", async () => {
    const lint = await lintTables();
    const [LINT_REMOVED, LINT_ENTRIES, LINT_PROPS, LINT_MOVED] = [
      lint.REMOVED_NAMES,
      lint.REMOVED_ENTRIES,
      lint.REMOVED_PROVIDER_PROPS,
      lint.MOVED_NAMES,
    ];
    expect([...REMOVED_NAMES].toSorted()).toEqual(Object.keys(LINT_REMOVED).toSorted());
    expect([...REMOVED_ENTRIES].toSorted()).toEqual(Object.keys(LINT_ENTRIES).toSorted());
    expect([...PROVIDER_PROPS].toSorted()).toEqual(Object.keys(LINT_PROPS).toSorted());
    expect(
      Object.fromEntries(
        Object.entries(MOVED_NAMES).map(([entry, names]) => [entry, [...names].toSorted()]),
      ),
    ).toEqual(
      Object.fromEntries(
        Object.entries(LINT_MOVED).map(([entry, names]) => [entry, Object.keys(names).toSorted()]),
      ),
    );
  });
});
