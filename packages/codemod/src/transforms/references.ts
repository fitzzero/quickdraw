// Other files that used a 4.x service class: an import of the class becomes
// an import of the service object, `new ProjectService(prisma)` becomes
// `projectService` (marked: the server registers services differently), and
// the class as a type becomes `typeof projectService`.
//
// A file that already binds the service object's name (a local
// `const chatService = new ChatService(prisma)`, a parameter
// `pushService: PushService`) imports the object under an alias
// (`chatService as chatServiceDef`) and uses that, so nothing refers to
// itself. Every use of a 4.x instance's member, found by type in any file
// but the services' own (`pushService.resubscribe(...)`, `gameService.sim`),
// is marked, since the service object has none of the instance's members.
// So is a dynamic `import()` of the class, with the `new` that follows it,
// which the codemod leaves for a person.

import { existsSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { type Identifier, Node, type SourceFile, SyntaxKind } from "ts-morph";
import type { Work } from "../apply";
import type { RunContext } from "../context";
import { type Category, MarkerSet } from "../markers";
import type { ServicePlan } from "../plan";
import { isUnder } from "../project";
import { serviceVar } from "./services";

/** What one file's rewrite works from. */
interface FileScope {
  readonly file: SourceFile;
  readonly plan: ServicePlan;
  readonly markers: MarkerSet;
  /** `server`, or `client` in the web app. */
  readonly category: Category;
}

/** Whether `identifier` declares a binding (a variable, a parameter, an import, a function or class). */
function declaresBinding(identifier: Identifier): boolean {
  const parent = identifier.getParent();
  if (
    Node.isVariableDeclaration(parent) ||
    Node.isParameterDeclaration(parent) ||
    Node.isBindingElement(parent) ||
    Node.isFunctionDeclaration(parent) ||
    Node.isClassDeclaration(parent) ||
    Node.isEnumDeclaration(parent)
  ) {
    return parent.getNameNode() === identifier;
  }
  if (Node.isImportSpecifier(parent)) {
    return (parent.getAliasNode() ?? parent.getNameNode()) === identifier;
  }
  return Node.isImportClause(parent) || Node.isNamespaceImport(parent);
}

/** Whether the file binds `name` anywhere. */
function bindsName(file: SourceFile, name: string): boolean {
  return file
    .getDescendantsOfKind(SyntaxKind.Identifier)
    .some((identifier) => identifier.getText() === name && declaresBinding(identifier));
}

/** `base`, or `base2`, `base3`... the first the file does not use. */
function freeName(file: SourceFile, base: string): string {
  const used = new Set(file.getDescendantsOfKind(SyntaxKind.Identifier).map((id) => id.getText()));
  let name = base;
  for (let index = 2; used.has(name); index += 1) {
    name = `${base}${String(index)}`;
  }
  return name;
}

/** The file a relative module specifier names, when the project holds it. */
function resolvedModule(file: SourceFile, specifier: string): SourceFile | undefined {
  if (!specifier.startsWith(".")) {
    return undefined;
  }
  const base = resolve(dirname(file.getFilePath()), specifier).replace(/\.(?:m?js|jsx)$/u, "");
  const candidates = [base, `${base}.ts`, `${base}.tsx`, `${base}/index.ts`, `${base}/index.tsx`];
  const project = file.getProject();
  for (const candidate of candidates) {
    const found = project.getSourceFile(candidate);
    if (found !== undefined || existsSync(candidate)) {
      return found;
    }
  }
  return undefined;
}

/** The names a dynamic `import()` of the class's file binds to the class (`const { ChatService } = await import(...)`). */
function dynamicImports(scope: FileScope, leafFile: SourceFile): Identifier[] {
  const { className } = scope.plan.service;
  const locals: Identifier[] = [];
  for (const call of scope.file.getDescendantsOfKind(SyntaxKind.CallExpression)) {
    const [argument] = call.getArguments();
    if (
      call.getExpression().getKind() !== SyntaxKind.ImportKeyword ||
      !Node.isStringLiteral(argument) ||
      resolvedModule(scope.file, argument.getLiteralValue()) !== leafFile
    ) {
      continue;
    }
    const declaration = call.getFirstAncestorByKind(SyntaxKind.VariableDeclaration);
    const name = declaration?.getNameNode();
    const element = Node.isObjectBindingPattern(name)
      ? name
          .getElements()
          .find((item) => (item.getPropertyNameNode()?.getText() ?? item.getName()) === className)
      : undefined;
    const local = element?.getNameNode();
    if (declaration === undefined || element === undefined || !Node.isIdentifier(local)) {
      continue;
    }
    scope.markers.add(
      declaration,
      scope.category,
      `${className} is imported dynamically here, and 5.0 has no class: import the service object ${serviceVar(scope.plan.service)} (pass it in qd.createServer({ services: [...] })), or call it through qd.caller(principal)`,
    );
    locals.push(local);
  }
  return locals;
}

/** Marks `new` on a dynamically imported class. */
function markDynamicUses(scope: FileScope, local: Identifier): void {
  const { className } = scope.plan.service;
  const target = serviceVar(scope.plan.service);
  for (const expression of scope.file.getDescendantsOfKind(SyntaxKind.NewExpression)) {
    if (expression.getExpression().getText() === local.getText()) {
      scope.markers.add(
        expression,
        scope.category,
        `the 4.x service was constructed here (new ${className}(...)): it is the object ${target} now`,
      );
    }
  }
}

/** The static imports and re-exports of the class from its file. */
function specifiersOf(file: SourceFile, leafFile: SourceFile, className: string) {
  return [
    ...file
      .getImportDeclarations()
      .filter((declaration) => declaration.getModuleSpecifierSourceFile() === leafFile)
      .flatMap((declaration) => declaration.getNamedImports()),
    ...file
      .getExportDeclarations()
      .filter((declaration) => declaration.getModuleSpecifierSourceFile() === leafFile)
      .flatMap((declaration) => declaration.getNamedExports()),
  ].filter((specifier) => specifier.getName() === className);
}

function rewriteFile(ctx: RunContext, file: SourceFile, plan: ServicePlan, work: Work): void {
  const leaf = plan.service.chain[0];
  const className = plan.service.className;
  const target = serviceVar(plan.service);
  if (leaf === undefined || file === leaf.getSourceFile()) {
    return;
  }
  const leafFile = leaf.getSourceFile();
  const web = ctx.layout.web;
  const scope: FileScope = {
    file,
    plan,
    markers: new MarkerSet(file),
    category: web !== undefined && isUnder(file, web.src) ? "client" : "server",
  };
  for (const local of dynamicImports(scope, leafFile)) {
    markDynamicUses(scope, local);
  }
  const specifiers = specifiersOf(file, leafFile, className);
  const fileWork = work.for(file);
  if (specifiers.length === 0) {
    fileWork.edits.push(...scope.markers.edits);
    return;
  }
  const existingAlias = specifiers
    .filter((specifier) => Node.isImportSpecifier(specifier))
    .map((specifier) => specifier.getAliasNode()?.getText())
    .find((alias) => alias !== undefined);
  const classLocal = existingAlias ?? className;
  // The service object's name here: the import's alias, else its own name,
  // unless the file binds that name already.
  const clash = existingAlias === undefined && bindsName(file, target);
  const local = existingAlias ?? (clash ? freeName(file, `${target}Def`) : target);
  for (const specifier of specifiers) {
    const nameNode = specifier.getNameNode();
    const aliased = clash && Node.isImportSpecifier(specifier);
    fileWork.edits.push({
      start: nameNode.getStart(),
      end: nameNode.getEnd(),
      text: aliased ? `${target} as ${local}` : target,
    });
  }
  const bindingNames = new Set(specifiers.map((specifier) => specifier.getNameNode()));
  for (const identifier of file.getDescendantsOfKind(SyntaxKind.Identifier)) {
    if (
      identifier.getText() !== classLocal ||
      bindingNames.has(identifier) ||
      identifier.getFirstAncestorByKind(SyntaxKind.ImportDeclaration) !== undefined
    ) {
      continue;
    }
    rewriteUse(scope, identifier, local, fileWork.edits);
  }
  fileWork.edits.push(...scope.markers.edits);
  fileWork.tidy = true;
}

/** Rewrites one use of the class: `new` becomes the object, a type `typeof` it; anything else is marked. */
function rewriteUse(
  scope: FileScope,
  identifier: Identifier,
  local: string,
  edits: { start: number; end: number; text: string }[],
): void {
  const { className } = scope.plan.service;
  const parent = identifier.getParent();
  if (Node.isNewExpression(parent) && parent.getExpression() === identifier) {
    edits.push({ start: parent.getStart(), end: parent.getEnd(), text: local });
    scope.markers.add(
      parent,
      scope.category,
      `the 4.x service was constructed here (new ${className}(...)): it is the object ${local} now; pass it in qd.createServer({ services: [...] })`,
    );
  } else if (Node.isTypeReference(parent)) {
    edits.push({ start: parent.getStart(), end: parent.getEnd(), text: `typeof ${local}` });
  } else if (!Node.isExportSpecifier(parent)) {
    scope.markers.add(
      identifier,
      scope.category,
      `${className} was the 4.x service class; the service is the object ${local} now`,
    );
  }
}

/** The files a service's own transform rewrites: its classes' and its method modules'. */
function serviceSources(plans: readonly ServicePlan[]): Set<SourceFile> {
  return new Set(
    plans.flatMap(({ service }) => [
      ...service.chain.map((cls) => cls.getSourceFile()),
      ...service.methods.flatMap((method) => method.register?.getSourceFile() ?? []),
    ]),
  );
}

/**
 * Marks every use of a 4.x instance's member outside the services' own
 * files, found by type: `pushService.resubscribe(...)` on a parameter,
 * `gameService.sim` on a binding destructured from a builder's result,
 * `services.chatService.x`. The service object has none of them.
 */
function markInstanceMembers(ctx: RunContext, plans: readonly ServicePlan[], work: Work): void {
  const byClass = new Map<unknown, ServicePlan>();
  for (const plan of plans) {
    const symbol = plan.service.chain[0]?.getSymbol();
    if (symbol !== undefined) {
      byClass.set(symbol, plan);
    }
  }
  const skipped = serviceSources(plans);
  const web = ctx.layout.web;
  for (const file of ctx.project.getSourceFiles()) {
    if (skipped.has(file)) {
      continue;
    }
    const markers = new MarkerSet(file);
    const category = web !== undefined && isUnder(file, web.src) ? "client" : "server";
    for (const access of file.getDescendantsOfKind(SyntaxKind.PropertyAccessExpression)) {
      const expression = access.getExpression();
      if (expression.getKind() === SyntaxKind.ThisKeyword) {
        continue;
      }
      const type = expression.getType().getNonNullableType();
      const plan = type.isClass() ? byClass.get(type.getSymbol()) : undefined;
      if (plan === undefined) {
        continue;
      }
      const { className, serviceName } = plan.service;
      markers.add(
        access,
        category,
        `${expression.getText()} is a 4.x ${className} instance, whose members (${access.getName()} here) the service object ${serviceVar(plan.service)} does not have: call a contract method through qd.caller(principal).${serviceName}.<method>(input), and move other logic into a module of its own`,
      );
    }
    work.for(file).edits.push(...markers.edits);
  }
}

/** Rewrites every other file's use of the migrated classes. */
export function rewriteReferences(
  ctx: RunContext,
  plans: readonly ServicePlan[],
  work: Work,
): void {
  markInstanceMembers(ctx, plans, work);
  for (const file of ctx.project.getSourceFiles()) {
    for (const plan of plans) {
      rewriteFile(ctx, file, plan, work);
    }
  }
}
