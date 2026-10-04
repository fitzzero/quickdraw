// The codemod on the 4.1 fixture app (test/fixtures/v4-app): the output and
// the report match the committed snapshot (test/fixtures/v4-app.expected;
// `vitest run -u` rewrites it, and a file the codemod stops writing must be
// deleted from it by hand), the access mapping writes the four forms the 4.x
// semantics call for, the report lists every manual item of the fixture at
// its file and line, a service class's fields, getters, constructor and
// overrides survive as marked module code, and a second run changes nothing.

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Node, Project, SyntaxKind } from "ts-morph";
// @ts-expect-error -- the lint plugin is plain JavaScript without types
import { kitShape as preferKit } from "../../lint/plugin/rules/prefer-kit.mjs";
import { runCodemod, type RunResult } from "../src/index";
import { kitShapeOf } from "../src/kits";
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
      methods: 22,
      contracts: 5,
      schemasMoved: 14,
      todoSchemas: 21,
      clientCalls: 8,
      wrappersDeleted: 3,
    });
    // the wrappers, and the file of types only they imported
    expect(result.deleted.toSorted()).toEqual([
      "apps/web/src/hooks/service-types.ts",
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

describe("a 4.x service class's members (label.ts)", () => {
  const label = (): string => output.get("apps/api/src/services/label.ts") ?? "";

  it("keeps every field as a marked module binding, with its initializer", () => {
    expect(label()).toMatch(
      /\[this\] 4\.x instance field renamed of LabelService: now module state[^\n]*\nconst renamed = new Set<string>\(\);/u,
    );
    expect(label()).toMatch(
      /\[this\] 4\.x instance field onChange[^\n]*\nlet onChange: LabelListener \| undefined;/u,
    );
    // a method binds a local `room`, so the field's binding takes another name
    expect(label()).toMatch(
      /\[this\] 4\.x instance field room[^\n]*\nexport let roomOfLabelService: string;/u,
    );
    // uses of the fields read the bindings
    expect(label()).toContain("renamed.add(label.id);");
    expect(label()).toContain("const room = roomOfLabelService;");
    expect(label()).not.toMatch(/this\.(?:renamed|onChange|room)\b/u);
  });

  it("keeps the constructor's assignments in a setup function that takes the parameters they use", () => {
    expect(label()).toContain(
      "export function setUpLabelService(options: { onChange?: LabelListener } = {}): void {\n  onChange = options.onChange;",
    );
  });

  it("hoists a getter into a function, which its reads call", () => {
    expect(label()).toContain("export function renamedCount(): number {\n  return renamed.size;");
  });

  it("drops a call of the 4.x base class under a marker that names it: super does not parse outside a class", () => {
    const code = label()
      .split("\n")
      .filter((line) => !line.trimStart().startsWith("//"));
    expect(code.filter((line) => /\bsuper\b/u.test(line))).toEqual([]);
    expect(label()).toContain(
      "// quickdraw-migrate: review [this] dropped super.unsubscribeSocket(socket), a call of the 4.x base class",
    );
    expect(label()).toMatch(
      /\[this\] super\.adminCreate\(data\) called the 4\.x base class[^\n]*\n {2}const created = await undefined;/u,
    );
  });

  it("marks this.constructor as instance state, not as a key of Object.prototype", () => {
    expect(label()).toMatch(
      /\[this\] this\.constructor was 4\.x service-instance state[^\n]*\n {2}return this\.constructor\.name;/u,
    );
  });

  it("puts a marker about a one-line literal above the statement holding it", () => {
    expect(label()).toMatch(
      /\[this\] this\.subscribers was 4\.x service-instance state[^\n]*\n {2}return \{ room, sockets: this\.subscribers/u,
    );
  });
});

describe("the web app's 4.x types", () => {
  it("drop a local type only a rewritten hook call's type arguments named", () => {
    const text = output.get("apps/web/src/components/RenameLabel.tsx") ?? "";
    expect(text).not.toContain("RenameLabelPayload");
    expect(text).not.toContain("type argument: nothing else names it");
  });

  it("give a one-argument UseCollectionResult 5.0's second argument", () => {
    expect(output.get("apps/web/src/hooks/useMyProjects.ts")).toContain(
      "export function useMyProjects(): UseCollectionResult<ProjectListItem, { readonly id: string }> {",
    );
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
      '{ service: "Moderate", entry: "Moderate", id: (input) => ((p) => p.labelId ?? null)(input) ?? "" }',
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

  it('writes "public" with rowless: true for a "Public" method whose input has an id', () => {
    const { form, markers } = accessOf("getProfile");
    expect(form).toBe('"public"');
    expect(markers.join("\n")).toContain(
      `${MARKER} [access] this method takes an id but its access "public" checks no row`,
    );
    expect(output.get("apps/api/src/services/user.ts")).toContain(
      'access: "public",\n      rowless: true,\n',
    );
    // a method without an id, or with a form that checks its row, needs no rowless
    const code = [...output].filter(([file]) => file.startsWith("apps/api/"));
    expect(code.flatMap(([, text]) => text.match(/^\s*rowless: true,$/gmu) ?? [])).toHaveLength(1);
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
    // and one above each handler whose 4.x DTO | null output became "entity"
    const nonNull = section("Contracts").filter((line) =>
      line.includes('the contract\'s output is "entity"'),
    );
    expect(nonNull.map((line) => /`([^`:]+):/u.exec(line)?.[1])).toEqual([
      "apps/api/src/services/project.ts",
      "apps/api/src/services/task/methods/update-task.ts",
    ]);
    expect(section("Contracts")).toHaveLength(result.stats.methods + 4 + nonNull.length);
  });

  it("keeps a carve-out's markers around an entity key the DTO declares inside it", () => {
    expect(output.get("packages/shared/src/contracts/project.ts")).toMatch(
      /keys: \[\n\s+"id",\n\s+"name",\n\s+"ownerId",\n\s+"acl",\n\s+\/\/ ── quickdraw-archive:start ──\n\s+"archived",\n\s+\/\/ ── quickdraw-archive:end ──\n\s+\]/u,
    );
  });

  it("lists each new file of a carve-out", () => {
    expect(section("Carve-outs")).toEqual([
      expect.stringMatching(
        /^- \[ \] `packages\/shared\/src\/contracts\/label\.ts:5` this file belongs to the quickdraw-labels carve-out/u,
      ),
    ]);
  });

  it("lists every method of a kit method's shape, marked above the method", () => {
    const listed = section("Methods a kit implements");
    expect(
      listed.map((line) => /^- \[ \] `[^`]+` (\w+) has the shape of/u.exec(line)?.[1]),
    ).toEqual([
      ...["getLabel", "listLabels", "createProject", "getProject", "deleteProject"],
      ...["createTask", "listTasks", "updateTask", "updateUser"],
    ]);
    for (const line of listed) {
      const name = /^- \[ \] `[^`]+` (\w+)/u.exec(line)?.[1] ?? "";
      expect(codeAt(line)).toMatch(new RegExp(`^\\s*${name}[:,]`, "u"));
    }
  });
});

describe("the kit shapes", () => {
  it("are the ones lint's prefer-kit reports", () => {
    const names = [
      ...["get", "getMany", "list", "create", "update", "delete", "reorder", "bulkUpdate"],
      ...["bulkDelete", "search", "share", "shareByName", "unshare", "listShares", "invite"],
      ...["inviteByName", "remove", "listMembers", "leave", "setRole", "setLevel"],
      ...["adminList", "adminGet", "adminCreate", "adminUpdate", "adminDelete", "adminMeta"],
      ...["getTask", "listTasks", "createTask", "updateTask", "deleteTask", "removeTask"],
      ...["getProject", "listCategories", "deleteCategory", "updateProjectMember"],
      ...["listAddresses", "listTaskes", "getCategory", "rename", "getMe", "find"],
    ];
    const models = ["task", "category", "address", "projectMember", "membership", undefined];
    const siblings = [[], ["rename", "leave"], ["share"], ["invite"], ["listMembers"]];
    for (const model of models) {
      for (const methods of siblings) {
        for (const name of names) {
          const lint = model === undefined ? undefined : preferKit(name, model, methods);
          const label = `${name} on ${String(model)} beside ${methods.join(", ")}`;
          expect(kitShapeOf(name, model, methods)?.method, label).toBe(lint?.method);
        }
      }
    }
    expect(kitShapeOf("remove", "task")).toBeUndefined();
    expect(kitShapeOf("remove", "task", ["invite"])?.method).toBe("remove");
    expect(kitShapeOf("remove", "projectMember")?.method).toBe("remove");
    expect(kitShapeOf("deleteTask", "task")?.method).toBe("delete");
  });
});
