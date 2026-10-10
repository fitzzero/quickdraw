// The codemod on the fixture app when the app has a formatter (oxfmt, a dev
// dependency with its own config, as in the quickdraw template): every file
// it writes passes the formatter's check as it is written (a pre-commit
// hook runs that check), the report points at the formatted lines, and a
// second run changes nothing at all, the report included.

import { spawnSync } from "node:child_process";
import { mkdirSync, readFileSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { main } from "../src/cli";
import { batches } from "../src/format";
import { runCodemod, type RunResult } from "../src/index";
import { findMarkers } from "../src/markers";
import { REPORT_FILE } from "../src/report";
import { copyFixture, readTree, removeCopies, REPO } from "./helpers";

const OXFMT = join(REPO, "node_modules", ".bin", "oxfmt");

let root = "";
let result: RunResult;

/** A copy of the fixture app with oxfmt installed and `config` as its .oxfmtrc.json. */
function withOxfmt(label: string, config = "{}\n"): string {
  const app = copyFixture(label);
  const manifestPath = join(app, "package.json");
  const manifest = JSON.parse(readFileSync(manifestPath, "utf8")) as Record<string, unknown>;
  writeFileSync(
    manifestPath,
    `${JSON.stringify({ ...manifest, devDependencies: { oxfmt: "^0.37.0" } }, null, 2)}\n`,
  );
  writeFileSync(join(app, ".oxfmtrc.json"), config);
  mkdirSync(join(app, "node_modules", ".bin"), { recursive: true });
  symlinkSync(OXFMT, join(app, "node_modules", ".bin", "oxfmt"));
  return app;
}

beforeAll(() => {
  root = withOxfmt("format");
  result = runCodemod({ root });
});

afterAll(() => {
  removeCopies();
});

describe("with the app's formatter", () => {
  it("formats every file it writes, the report too", () => {
    expect(result.formatter).toEqual({ name: "oxfmt", ok: true });
    const written = [...result.changed, ...result.created];
    expect(written).toContain(REPORT_FILE);
    const check = spawnSync(OXFMT, ["--check", ...written], { cwd: root, encoding: "utf8" });
    expect(check.stdout + check.stderr).toContain("All matched files use the correct format");
    expect(check.status).toBe(0);
  });

  it("lists each marker at the line it has in the formatted file", () => {
    const tree = readTree(root);
    const listed = (tree.get(REPORT_FILE) ?? "")
      .split("\n")
      .filter((line) => line.startsWith("- [ ] "))
      .map((line) => /`([^`]+)`/u.exec(line)?.[1]);
    const markers = [...tree]
      .flatMap(([file, text]) => findMarkers(text, file))
      .map((marker) => `${marker.file}:${String(marker.line)}`);
    expect(listed.toSorted()).toEqual(markers.toSorted());
    expect(listed.length).toBe(result.items);
  });

  it("changes nothing at all the second time it runs", () => {
    const before = readTree(root);
    const again = runCodemod({ root });
    expect({ changed: again.changed, created: again.created, deleted: again.deleted }).toEqual({
      changed: [],
      created: [],
      deleted: [],
    });
    expect(readTree(root)).toEqual(before);
  });
});

describe("when the app's formatter config ignores files", () => {
  it("formats the code it wrote and leaves the ignored report as written", () => {
    const app = withOxfmt("format-ignore", `${JSON.stringify({ ignorePatterns: ["**/*.md"] })}\n`);
    const run = runCodemod({ root: app });
    expect(run.formatter).toEqual({ name: "oxfmt", ok: true });
    const code = [...run.changed, ...run.created].filter((file) => !file.endsWith(".md"));
    const check = spawnSync(OXFMT, ["--check", ...code], { cwd: app, encoding: "utf8" });
    expect(check.status).toBe(0);
  });
});

describe("when the formatter fails", () => {
  it("prints its exit code, its own error and the files it left", () => {
    const app = withOxfmt("format-broken", "{bad\n");
    const out: string[] = [];
    main(["v5", app], { out: (text) => out.push(text), err: (text) => out.push(text) });
    const text = out.join("");
    expect(text).toContain("oxfmt failed on the files written (exit code 1)");
    expect(text).toContain("Failed to load configuration file");
    expect(text).toMatch(/files left unformatted:\n {4}\S+\.ts/u);
  });
});

describe("batches", () => {
  it("splits by count and by characters", () => {
    expect(batches(["a", "b", "c", "d"], 3)).toEqual([["a", "b", "c"], ["d"]]);
    expect(batches(["aaaa", "bbbb", "cc"], 10, 10)).toEqual([["aaaa", "bbbb"], ["cc"]]);
    expect(batches([])).toEqual([]);
  });

  it("formats the same tree in batches of 3 as in one", () => {
    const small = withOxfmt("format-batch");
    runCodemod({ root: small, formatBatch: 3 });
    expect(readTree(small)).toEqual(readTree(root));
  });
});
