// Writes one contract per service into the shared package
// (`contracts/<name>.ts`), the helpers their moved schemas need
// (`contracts/helpers.ts`), the `contracts` map the web client is built from
// (`contracts/index.ts`), and the shared package's export of them. Service
// names are kept exactly: stored grants (`User.serviceAccess`) name them. A
// service of a template carve-out (`carveOuts.ts`) keeps its markers: its
// lines in `contracts/index.ts` and the helpers only it uses sit between
// them, and its contract file says it belongs to the carve-out.

import { join } from "node:path";
import { Node, SyntaxKind, type SourceFile, type TypeNode } from "ts-morph";
import { regionMarkers } from "../carveOuts";
import type { RunContext } from "../context";
import { relativeSpecifier } from "../imports";
import { repoPath } from "../layout";
import { markerText } from "../markers";
import type { MovedDeclaration } from "../schemas";
import type { MethodPlan, ServicePlan } from "../plan";
import { quote } from "../text";

const CORE = "@fitzzero/quickdraw-core";

/** `import type { ... }` statements for the names `nodes` use, from `file`'s directory. */
function typeImports(ctx: RunContext, nodes: readonly Node[], file: string): string[] {
  const byModule = new Map<string, Set<string>>();
  const add = (source: string, name: string): void => {
    const names = byModule.get(source) ?? new Set<string>();
    names.add(name);
    byModule.set(source, names);
  };
  for (const node of nodes) {
    if (Node.isInterfaceDeclaration(node) || Node.isTypeAliasDeclaration(node)) {
      add(
        relativeSpecifier(file, node.getSourceFile().getFilePath(), ctx.js.shared),
        node.getName(),
      );
      continue;
    }
    const references = [node, ...node.getDescendants()].filter((child) =>
      Node.isTypeReference(child),
    );
    for (const reference of references) {
      const name = reference.getTypeName().getText().split(".")[0] ?? "";
      const identifier = reference.getFirstDescendantByKind(SyntaxKind.Identifier) ?? reference;
      const declaration = identifier.getSymbol()?.getDeclarations()[0];
      if (
        declaration === undefined ||
        declaration.getSourceFile().isInNodeModules() ||
        declaration.getSourceFile().isDeclarationFile()
      ) {
        continue;
      }
      if (Node.isImportSpecifier(declaration)) {
        const statement = declaration.getImportDeclaration();
        const target = statement.getModuleSpecifierSourceFile();
        const source = statement.getModuleSpecifierValue();
        const imported =
          declaration.getAliasNode() === undefined ? name : `${declaration.getName()} as ${name}`;
        add(
          source.startsWith(".") && target !== undefined
            ? relativeSpecifier(file, target.getFilePath(), ctx.js.shared)
            : source,
          imported,
        );
      } else if (
        Node.isInterfaceDeclaration(declaration) ||
        Node.isTypeAliasDeclaration(declaration) ||
        Node.isEnumDeclaration(declaration)
      ) {
        if (!declaration.isExported()) {
          declaration.setIsExported(true);
        }
        add(
          relativeSpecifier(file, declaration.getSourceFile().getFilePath(), ctx.js.shared),
          name,
        );
      }
    }
  }
  return [...byModule.entries()]
    .toSorted(([a], [b]) => a.localeCompare(b))
    .map(
      ([source, names]) =>
        `import type { ${[...names].toSorted().join(", ")} } from ${quote(source)};`,
    );
}

function methodLine(method: MethodPlan): string {
  return [
    `    ${markerText("contract", method.notes.join("; "))}`,
    `    ${method.name}: ${method.kind}({ input: ${method.input}, output: ${method.output} }),`,
  ].join("\n");
}

function builders(plan: ServicePlan): string[] {
  const code = [
    plan.entity?.code ?? "",
    ...plan.methods.flatMap((method) => [method.input, method.output]),
  ].join("\n");
  const used = ["defineContract"];
  for (const name of ["listOf", "nullable", "todoSchema"]) {
    if (code.includes(`${name}(`) || code.includes(`${name}<`)) {
      used.push(name);
    }
  }
  for (const kind of ["mutation", "query"] as const) {
    if (plan.methods.some((method) => method.kind === kind)) {
      used.push(kind);
    }
  }
  return used.toSorted();
}

/** The `[carve-out]` marker a new file of carve-out `name` carries. */
export function carveOutMarker(name: string): string {
  return markerText(
    "carve-out",
    `this file belongs to the ${name} carve-out (it was written from code between its markers): list it wherever the carve-out's own files are (a fork script's delete list), then delete this line`,
  );
}

function header(ctx: RunContext, plan: ServicePlan): string {
  const service = plan.service;
  const files = [
    ...new Set(
      service.methods.map((method) =>
        repoPath(ctx.layout, method.call.getSourceFile().getFilePath()),
      ),
    ),
  ];
  return [
    `// The contract of ${service.serviceName}, written by @fitzzero/quickdraw-codemod from`,
    `// ${service.methodMapName ?? "its 4.x method map"} and the defineMethod calls of ${service.className}`,
    `// (${files.join(", ") || repoPath(ctx.layout, service.chain[0]?.getSourceFile().getFilePath() ?? "")}).`,
    "// Every marker below says what to check.",
    ...(plan.carveOut === undefined ? [] : [carveOutMarker(plan.carveOut)]),
  ].join("\n");
}

function contractBody(plan: ServicePlan): string[] {
  const lines = [
    `export const ${plan.contractVar} = defineContract(${quote(plan.service.serviceName)}, {`,
  ];
  if (plan.entity !== undefined) {
    lines.push(`  ${markerText("contract", plan.entity.note)}`, `  entity: ${plan.entity.code},`);
  }
  if (plan.unimplemented.length > 0) {
    const names = plan.unimplemented.join(", ");
    lines.push(
      `  ${markerText("contract", `the 4.x method map also names ${names}, which no defineMethod call implements: add them here and in the service, or drop them`)}`,
    );
  }
  lines.push("  methods: {", ...plan.methods.map((method) => methodLine(method)), "  },", "});");
  return lines;
}

/** The contract file's text. */
function contractText(ctx: RunContext, plan: ServicePlan, helpers: ReadonlySet<string>): string {
  const moved = plan.methods.flatMap((method) =>
    method.moved === undefined ? [] : [method.moved],
  );
  const locals = dedupe(
    moved
      .flatMap((schema) => schema.declarations)
      .filter((declaration) => declaration.place === "local"),
  );
  const zod = [...new Set(moved.flatMap((schema) => schema.zod.map((entry) => entry.statement)))];
  const direct = [...new Set(moved.flatMap((schema) => schema.directHelpers))].filter((name) =>
    helpers.has(name),
  );
  const typeNodes: Node[] = plan.methods.flatMap((method) =>
    [method.moved === undefined ? method.payload : undefined, method.todoResponse].filter(
      (node): node is TypeNode => node !== undefined,
    ),
  );
  if (plan.entity?.dto !== undefined) {
    typeNodes.push(plan.entity.dto);
  }
  const imports = [
    `import { ${builders(plan).join(", ")} } from ${quote(CORE)};`,
    ...zod,
    ...typeImports(ctx, typeNodes, plan.contractFile),
    ...(direct.length === 0
      ? []
      : [
          `import { ${direct.toSorted().join(", ")} } from ${quote(relativeSpecifier(plan.contractFile, join(ctx.layout.shared.src, "contracts", "helpers.ts"), ctx.js.shared))};`,
        ]),
  ];
  const body = locals.map((declaration) =>
    declaration.docs === "" ? declaration.code : `${declaration.docs}\n${declaration.code}`,
  );
  return [
    header(ctx, plan),
    "",
    ...imports,
    "",
    ...(body.length > 0 ? [body.join("\n\n"), ""] : []),
    ...contractBody(plan),
    "",
  ].join("\n");
}

function dedupe(declarations: readonly MovedDeclaration[]): MovedDeclaration[] {
  const seen = new Set<string>();
  return declarations.filter((declaration) => {
    if (seen.has(declaration.key)) {
      return false;
    }
    seen.add(declaration.key);
    return true;
  });
}

function createFile(ctx: RunContext, path: string, text: string): SourceFile | undefined {
  if (ctx.project.getSourceFile(path) !== undefined) {
    return undefined;
  }
  const file = ctx.project.createSourceFile(path, text);
  ctx.created.add(path);
  return file;
}

/**
 * Two helpers of one name from different files cannot share helpers.ts: the
 * methods whose schemas need either keep their schema in the api package.
 */
function withoutHelperClashes(plans: readonly ServicePlan[]): ServicePlan[] {
  const keysByName = new Map<string, Set<string>>();
  for (const declaration of plans.flatMap((plan) =>
    plan.methods.flatMap((method) => method.moved?.declarations ?? []),
  )) {
    if (declaration.place === "helper") {
      keysByName.set(
        declaration.name,
        (keysByName.get(declaration.name) ?? new Set()).add(declaration.key),
      );
    }
  }
  const clashing = new Set(
    [...keysByName].filter(([, keys]) => keys.size > 1).map(([name]) => name),
  );
  if (clashing.size === 0) {
    return [...plans];
  }
  return plans.map((plan) => ({
    ...plan,
    methods: plan.methods.map((method) =>
      method.moved?.declarations.some(
        (declaration) => declaration.place === "helper" && clashing.has(declaration.name),
      ) === true
        ? {
            ...method,
            moved: undefined,
            input: method.fallbackInput,
            notes: [
              ...method.notes,
              "input: todoSchema, since its schema needs a helper whose name another helper has",
            ],
          }
        : method,
    ),
  }));
}

/** `lines` between the markers of carve-out `name`, or as they are without one. */
function inRegion(name: string | undefined, lines: readonly string[]): string[] {
  if (name === undefined || lines.length === 0) {
    return [...lines];
  }
  const markers = regionMarkers(name);
  return [markers.start, ...lines, markers.end];
}

/** The carve-out a helper belongs to: the one every contract using it belongs to, if any. */
function helperRegions(plans: readonly ServicePlan[]): Map<string, string | undefined> {
  const regions = new Map<string, Set<string | undefined>>();
  for (const plan of plans) {
    for (const declaration of plan.methods.flatMap((method) => method.moved?.declarations ?? [])) {
      if (declaration.place === "helper") {
        const set = regions.get(declaration.key) ?? new Set();
        set.add(plan.carveOut);
        regions.set(declaration.key, set);
      }
    }
  }
  return new Map(
    [...regions].map(([key, set]) => [key, set.size === 1 ? [...set][0] : undefined] as const),
  );
}

/** Writes `contracts/helpers.ts` with the helpers the moved schemas need; returns their names. */
function writeHelpers(ctx: RunContext, plans: readonly ServicePlan[]): Set<string> {
  const moved = plans.flatMap((plan) =>
    plan.methods.flatMap((method) => (method.moved === undefined ? [] : [method.moved])),
  );
  const helpers = dedupe(
    moved
      .flatMap((schema) => schema.declarations)
      .filter((declaration) => declaration.place === "helper"),
  );
  const regions = helperRegions(plans);
  const names = new Set(helpers.map((helper) => helper.name));
  if (helpers.length === 0) {
    return names;
  }
  const zod = [...new Set(moved.flatMap((schema) => schema.zod.map((entry) => entry.statement)))];
  const text = [
    "// Schema helpers moved here from the api package by @fitzzero/quickdraw-codemod,",
    "// for the contracts' schemas. The api package keeps its own copies.",
    "",
    ...zod,
    "",
    helpers
      .map((helper) =>
        inRegion(regions.get(helper.key), [
          `${helper.docs === "" ? "" : `${helper.docs}\n`}export ${helper.code}`,
        ]).join("\n"),
      )
      .join("\n\n"),
    "",
  ].join("\n");
  createFile(ctx, join(ctx.layout.shared.src, "contracts", "helpers.ts"), text);
  return names;
}

/** Adds the new contracts to `contracts/index.ts` and its `contracts` map, creating it when needed. */
function writeIndex(ctx: RunContext, plans: readonly ServicePlan[]): void {
  const path = join(ctx.layout.shared.src, "contracts", "index.ts");
  const specifier = (plan: ServicePlan): string =>
    relativeSpecifier(path, plan.contractFile, ctx.js.shared);
  const existing = ctx.project.getSourceFile(path);
  if (existing === undefined) {
    // the plans of each carve-out together, after those of none, each group between its markers
    const names = [...new Set(plans.flatMap((plan) => plan.carveOut ?? []))].toSorted();
    const groups = [undefined, ...names]
      .map((name) => ({ name, plans: plans.filter((plan) => plan.carveOut === name) }))
      .filter((group) => group.plans.length > 0);
    const each = (line: (plan: ServicePlan) => string, indent = ""): string[] =>
      groups.flatMap((group) =>
        inRegion(group.name, group.plans.map(line)).map((text) =>
          text.startsWith("//") ? `${indent}${text}` : text,
        ),
      );
    const text = [
      "// The app's contracts, written by @fitzzero/quickdraw-codemod. The web client is",
      "// built from `contracts` (`createQuickdrawClient(contracts)`), keyed by service",
      "// name so every 4.x call site keeps its name: `qd.projectService.getProject`.",
      "",
      ...each((plan) => `import { ${plan.contractVar} } from ${quote(specifier(plan))};`),
      "",
      ...groups.flatMap((group) =>
        inRegion(group.name, [
          `export { ${group.plans.map((plan) => plan.contractVar).join(", ")} };`,
        ]),
      ),
      "",
      "export const contracts = {",
      ...each((plan) => `  ${plan.service.serviceName}: ${plan.contractVar},`, "  "),
      "};",
      "",
    ].join("\n");
    createFile(ctx, path, text);
    return;
  }
  const map = existing
    .getVariableDeclaration("contracts")
    ?.getInitializerIfKind(SyntaxKind.ObjectLiteralExpression);
  for (const plan of plans) {
    if (map?.getProperty(plan.service.serviceName) !== undefined) {
      continue;
    }
    const markers = plan.carveOut === undefined ? undefined : regionMarkers(plan.carveOut);
    const around =
      markers === undefined
        ? {}
        : { leadingTrivia: `${markers.start}\n`, trailingTrivia: `\n${markers.end}` };
    existing.addImportDeclaration({
      moduleSpecifier: specifier(plan),
      namedImports: [plan.contractVar],
      ...around,
    });
    existing.addExportDeclaration({ namedExports: [plan.contractVar], ...around });
    map?.addPropertyAssignment({
      name: plan.service.serviceName,
      initializer: plan.contractVar,
      ...around,
    });
  }
}

/** Makes the shared package's entry export the contracts. */
function exportFromShared(ctx: RunContext): void {
  const entry = ctx.project.getSourceFile(join(ctx.layout.shared.src, "index.ts"));
  if (entry === undefined) {
    return;
  }
  const exported = entry
    .getExportDeclarations()
    .some((declaration) =>
      /\/contracts(\/index)?(\.js)?$/u.test(declaration.getModuleSpecifierValue() ?? ""),
    );
  if (!exported) {
    entry.addExportDeclaration({
      moduleSpecifier: ctx.js.shared ? "./contracts/index.js" : "./contracts",
    });
  }
}

/** Writes every planned contract, and the files around them. */
export function writeContracts(ctx: RunContext, plans: readonly ServicePlan[]): ServicePlan[] {
  const fresh = withoutHelperClashes(
    plans.filter((plan) => ctx.project.getSourceFile(plan.contractFile) === undefined),
  );
  if (fresh.length === 0) {
    return fresh;
  }
  const helpers = writeHelpers(ctx, fresh);
  for (const plan of fresh) {
    const file = createFile(ctx, plan.contractFile, contractText(ctx, plan, helpers));
    file?.formatText({ indentSize: 2, convertTabsToSpaces: true });
    ctx.stats.contracts += 1;
  }
  writeIndex(ctx, fresh);
  exportFromShared(ctx);
  return fresh;
}
