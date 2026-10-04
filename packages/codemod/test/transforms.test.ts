// The codemod on the 4.1 fixture app (test/fixtures/v4-app): the output and
// the report match the committed snapshot (test/fixtures/v4-app.expected;
// `vitest run -u` rewrites it), the access mapping writes the four forms the
// 4.x semantics call for, the report lists every manual item of the fixture
// at its file and line, and a second run changes nothing.

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Node, Project, SyntaxKind } from "ts-morph";
import { runCodemod, type RunResult } from "../src/index";
import { findMarkers, MARKER } from "../src/markers";
import { REPORT_FILE } from "../src/report";
import { copyFixture, EXPECTED, FIXTURE, readTree, removeCopies } from "./helpers";

let root = "";
let result: RunResult;
let output = new Map<string, string>();

beforeAll(() => {
  root = copyFixture("transforms");
  result = runCodemod({ root });
  output = readTree(root);
});

afterAll(() => {
  removeCopies();
});

describe("the output on the 4.1 fixture app", () => {
  it("matches the committed snapshot, file by file", async () => {
    for (const [file, text] of output) {
      await expect(text, file).toMatchFileSnapshot(join(EXPECTED, file));
    }
  });

  it("writes no file the snapshot lacks, and leaves none of its files out", () => {
    // `vitest run -u` writes new snapshot files, but never deletes stale ones
    const expected = existsSync(EXPECTED) ? [...readTree(EXPECTED).keys()] : [...output.keys()];
    expect([...output.keys()]).toEqual(expected);
  });

  it("converts every service, method and hook call, and deletes the wrapper hooks", () => {
    expect(result.stats).toEqual({
      services: 5,
      methods: 21,
      contracts: 5,
      schemasMoved: 13,
      todoSchemas: 20,
      clientCalls: 7,
      wrappersDeleted: 3,
    });
    expect(result.deleted.toSorted()).toEqual([
      "apps/web/src/hooks/useService.ts",
      "apps/web/src/hooks/useServiceQuery.ts",
      "apps/web/src/hooks/useSubscription.ts",
    ]);
    expect(output.has("packages/shared/src/contracts/index.ts")).toBe(true);
  });

  it("changes nothing the second time it runs", () => {
    const again = runCodemod({ root });
    expect({ changed: again.changed, created: again.created, deleted: again.deleted }).toEqual({
      changed: [],
      created: [],
      deleted: [],
    });
    expect(readTree(root)).toEqual(output);
    expect(again.report).toBe(result.report);
  });
});

/** The access form of method `method` in the output, and the markers right above it. */
function accessOf(method: string): { form: string; markers: string[] } {
  const project = new Project({ useInMemoryFileSystem: true });
  for (const [file, text] of output) {
    if (!file.startsWith("apps/api/src/services/")) {
      continue;
    }
    const source = project.createSourceFile(file, text);
    for (const object of source.getDescendantsOfKind(SyntaxKind.ObjectLiteralExpression)) {
      const parent = object.getParent();
      const named =
        (Node.isPropertyAssignment(parent) && parent.getName() === method) ||
        (Node.isSatisfiesExpression(parent) &&
          parent.getParent()?.getText().startsWith(`${method} =`) === true);
      const access = named ? object.getProperty("access") : undefined;
      if (access !== undefined && Node.isPropertyAssignment(access)) {
        const markers = access.getLeadingCommentRanges().map((range) => range.getText());
        return { form: access.getInitializerOrThrow().getText(), markers };
      }
    }
  }
  throw new Error(`no method ${method} in the output`);
}

describe("the access mapping", () => {
  it('writes "public" for a "Public" method', () => {
    expect(accessOf("ping")).toEqual({ form: '"public"', markers: [] });
  });

  it("writes { service: L, entry: L, id } for a method with a row id, never { entry: L }", () => {
    // an explicit resolveEntryId reading one key
    expect(accessOf("getMembers").form).toBe('{ service: "Read", entry: "Read", id: "projectId" }');
    expect(accessOf("moveTask").form).toBe(
      '{ service: "Moderate", entry: "Moderate", id: "taskId" }',
    );
    // no resolveEntryId: 4.x read payload.id implicitly
    expect(accessOf("getProject").form).toBe('{ service: "Read", entry: "Read", id: "id" }');
    expect(accessOf("deleteProject").form).toBe('{ service: "Admin", entry: "Admin", id: "id" }');
    expect(accessOf("updateTask").form).toBe(
      '{ service: "Moderate", entry: "Moderate", id: "id" }',
    );
    // a resolveEntryId that is more than a key stays a function, marked
    expect(accessOf("renameLabel").form).toBe(
      '{ service: "Moderate", entry: "Moderate", id: (input: ParsedInputOf<typeof labelContract, "renameLabel">) => ((p) => p.labelId ?? null)(input) ?? "" }',
    );
    expect(accessOf("renameLabel").markers.join("\n")).toContain(
      `${MARKER} [access] 4.x's resolveEntryId was a function`,
    );
  });

  it('writes "authenticated" with a review marker for "Read" without a row id', () => {
    for (const method of [
      "createProject",
      "listMyProjects",
      "getMe",
      "createTask",
      "listTasks",
      "listLabels",
    ]) {
      const { form, markers } = accessOf(method);
      expect(form, method).toBe('"authenticated"');
      expect(markers.join("\n"), method).toContain(
        `${MARKER} [access] "Read" with no row id let every signed-in user call this in 4.x`,
      );
    }
  });

  it('writes { service: L } for "Moderate" or "Admin" without a row id', () => {
    expect(accessOf("stats")).toEqual({ form: '{ service: "Admin" }', markers: [] });
    expect(accessOf("deleteAllLabels")).toEqual({ form: '{ service: "Admin" }', markers: [] });
    expect(accessOf("reindexProject")).toEqual({ form: '{ service: "Moderate" }', markers: [] });
  });

  it("keeps every service name exactly, since stored grants name them", () => {
    const names = [...output.values()].join("\n").match(/defineContract\("(\w+)"/gu);
    expect(names).toEqual([
      'defineContract("healthService"',
      'defineContract("labelService"',
      'defineContract("projectService"',
      'defineContract("taskService"',
      'defineContract("userService"',
    ]);
  });
});

/** How often `pattern` matches in the fixture's api sources. */
function countInFixture(pattern: RegExp): number {
  let count = 0;
  for (const [file, text] of readTree(FIXTURE)) {
    if (file.startsWith("apps/api/src/services/")) {
      count += text.match(pattern)?.length ?? 0;
    }
  }
  return count;
}

describe("the report", () => {
  const items = (): ReturnType<typeof findMarkers> =>
    [...output].flatMap(([file, text]) => findMarkers(text, file));
  const section = (title: string): string[] => {
    const text = output.get(REPORT_FILE) ?? "";
    const start = text.indexOf(`## ${title}\n`);
    const end = text.indexOf("\n## ", start + 1);
    return text
      .slice(start, end === -1 ? undefined : end)
      .split("\n")
      .filter((line) => line.startsWith("- [ ] "));
  };
  /** The line below the item's marker: the code it is about. */
  const codeAt = (line: string): string => {
    const [, file = "", number = "0"] = /`([^`:]+):(\d+)`/u.exec(line) ?? [];
    const lines = (output.get(file) ?? "").split("\n");
    let next = Number(number);
    while ((lines[next] ?? "").includes(MARKER)) {
      next += 1;
    }
    return lines.slice(next, next + 3).join("\n");
  };

  it("is written at the repository root, and lists every marker in the code, at its file and line", () => {
    expect(readFileSync(join(root, REPORT_FILE), "utf8")).toBe(result.report);
    const listed = (output.get(REPORT_FILE) ?? "")
      .split("\n")
      .filter((line) => line.startsWith("- [ ] "));
    expect(listed.map((line) => /`([^`]+)`/u.exec(line)?.[1]).toSorted()).toEqual(
      items()
        .map((item) => `${item.file}:${String(item.line)}`)
        .toSorted(),
    );
    expect(result.items).toBe(items().length);
  });

  it("lists every hand emit of the fixture", () => {
    const emits = countInFixture(
      /\.(?:emitUpdate|emitCollection\w+|notifyCollections|emitToRoom\w*|kickFromCollection)\(/gu,
    );
    const listed = section("Hand emits to delete");
    expect(listed).toHaveLength(emits);
    for (const line of listed) {
      expect(codeAt(line)).toMatch(/\.(?:emit|notify|kick)\w*\(/u);
    }
  });

  it("lists every this.create, this.update and this.delete", () => {
    const listed = section("this.create, this.update and this.delete to write through db");
    expect(listed).toHaveLength(countInFixture(/this\.(?:create|update|delete)\(/gu));
    for (const line of listed) {
      expect(codeAt(line)).toMatch(/this\.(?:create|update|delete)\(/u);
    }
  });

  it("lists every access override, toDto and protected fields, collection, lifecycle hook and installAdminMethods", () => {
    const overrides = countInFixture(/override (?:async )?(?:checkAccess|checkEntryACL)\(/gu);
    const placeholders = 2;
    expect(section("Access overrides to turn into a policy")).toHaveLength(
      overrides + placeholders,
    );
    expect(section("toDto and protected fields to turn into projections and fields")).toHaveLength(
      countInFixture(/override (?:async )?(?:toDto|getProtectedFields)\(/gu),
    );
    expect(section("Collections to declare in contracts")).toHaveLength(
      countInFixture(/this\.defineCollection\(/gu),
    );
    expect(section("Lifecycle hooks")).toHaveLength(
      countInFixture(/override async (?:before|after)(?:Create|Update|Delete)\(/gu),
    );
    expect(section("installAdminMethods to replace with the admin kit")).toHaveLength(
      countInFixture(/this\.installAdminMethods\(/gu),
    );
    for (const line of section("Collections to declare in contracts")) {
      expect(codeAt(line)).toMatch(/^const \w+Collection = \{/u);
    }
  });

  it("lists a contract item for every migrated method and entity", () => {
    expect(section("Contracts")).toHaveLength(result.stats.methods + 4);
  });
});
