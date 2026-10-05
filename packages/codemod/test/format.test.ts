// The codemod on the fixture app when the app has a formatter (oxfmt, a dev
// dependency with its own config, as in the quickdraw template): every file
// it writes passes the formatter's check as it is written (a pre-commit
// hook runs that check), the report points at the formatted lines, and a
// second run changes nothing at all, the report included.

import { spawnSync } from "node:child_process";
import { mkdirSync, readFileSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { runCodemod, type RunResult } from "../src/index";
import { findMarkers } from "../src/markers";
import { REPORT_FILE } from "../src/report";
import { copyFixture, readTree, removeCopies, REPO } from "./helpers";

const OXFMT = join(REPO, "node_modules", ".bin", "oxfmt");

let root = "";
let result: RunResult;

beforeAll(() => {
  root = copyFixture("format");
  const manifestPath = join(root, "package.json");
  const manifest = JSON.parse(readFileSync(manifestPath, "utf8")) as Record<string, unknown>;
  writeFileSync(
    manifestPath,
    `${JSON.stringify({ ...manifest, devDependencies: { oxfmt: "^0.37.0" } }, null, 2)}\n`,
  );
  writeFileSync(join(root, ".oxfmtrc.json"), "{}\n");
  mkdirSync(join(root, "node_modules", ".bin"), { recursive: true });
  symlinkSync(OXFMT, join(root, "node_modules", ".bin", "oxfmt"));
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
