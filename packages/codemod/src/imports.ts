// Imports the transforms add and remove. New relative imports follow the
// package's own habit: with a `.js` extension where its relative imports
// have one (NodeNext packages), without where they do not (bundlers).

import { dirname, relative, resolve } from "node:path";
import { Node, SyntaxKind, type Project, type SourceFile, type StringLiteral } from "ts-morph";
import { regionOf, regionsOf } from "./carveOuts";
import { isUnder } from "./project";

/** A relative module specifier from `from` to `to` (both file paths). */
export function relativeSpecifier(from: string, to: string, withJs: boolean): string {
  const target = to.replace(/\.tsx?$/u, "");
  let path = relative(dirname(from), target).split("\\").join("/");
  if (!path.startsWith(".")) {
    path = `./${path}`;
  }
  if (path.endsWith("/index")) {
    path = withJs ? `${path}.js` : path.slice(0, -"/index".length) || ".";
  } else if (withJs) {
    path = `${path}.js`;
  }
  return path;
}

/**
 * The module specifier `literal` (of an import, or of an `import("...")`
 * type) written from the file at `from` instead: a relative one names the
 * file it resolves to, a package name stays as it is.
 */
export function rebasedSpecifier(literal: StringLiteral, from: string, withJs: boolean): string {
  const specifier = literal.getLiteralValue();
  if (!specifier.startsWith(".")) {
    return specifier;
  }
  const target = literal
    .getSymbol()
    ?.getDeclarations()
    .find((declaration) => Node.isSourceFile(declaration));
  return target === undefined
    ? specifier
    : relativeSpecifier(from, target.getSourceFile().getFilePath(), withJs);
}

/** Whether the relative imports under `dir` end in `.js`. */
export function usesJsExtension(project: Project, dir: string): boolean {
  let withJs = 0;
  let without = 0;
  for (const file of project.getSourceFiles()) {
    if (!isUnder(file, dir)) {
      continue;
    }
    for (const declaration of [...file.getImportDeclarations(), ...file.getExportDeclarations()]) {
      const specifier = declaration.getModuleSpecifierValue();
      if (specifier?.startsWith(".") === true) {
        if (specifier.endsWith(".js")) {
          withJs += 1;
        } else {
          without += 1;
        }
      }
    }
  }
  return withJs > without;
}

/**
 * Adds `name` to the file's import from `module` (as `options.alias`, when
 * given), creating the import when needed.
 */
export function ensureImport(
  file: SourceFile,
  module: string,
  name: string,
  options: { readonly typeOnly?: boolean; readonly alias?: string | undefined } = {},
): void {
  const typeOnly = options.typeOnly === true;
  const local = options.alias ?? name;
  const bound = file
    .getImportDeclarations()
    .some(
      (declaration) =>
        declaration.getModuleSpecifierValue() === module &&
        declaration
          .getNamedImports()
          .some(
            (specifier) =>
              (specifier.getAliasNode() ?? specifier.getNameNode()).getText() === local,
          ),
    );
  if (bound) {
    // Already imported, as a value or a type (`import { type X }` included).
    return;
  }
  // `{ name as other }` binds another name: `name` is added beside it.
  const specifier = options.alias === undefined ? name : { name, alias: options.alias };
  const existing = file
    .getImportDeclarations()
    .find(
      (declaration) =>
        declaration.getModuleSpecifierValue() === module &&
        declaration.getNamespaceImport() === undefined &&
        declaration.isTypeOnly() === typeOnly,
    );
  if (existing !== undefined) {
    existing.addNamedImport(specifier);
    return;
  }
  const structure = { moduleSpecifier: module, namedImports: [specifier], isTypeOnly: typeOnly };
  const index = importIndex(file);
  if (index === undefined) {
    file.addImportDeclaration(structure);
  } else {
    file.insertImportDeclaration(index, structure);
  }
}

/**
 * Where an import the codemod adds goes among the file's statements, its
 * comments counted (the count of its imports is no such index, and could
 * land inside a header comment): after its last import outside the
 * template's carve-out regions (`carveOuts.ts`), whose lines a fork strips,
 * or before the region of its first import when every import is in one.
 * `undefined` for a file without imports.
 */
function importIndex(file: SourceFile): number | undefined {
  const imports = file.getImportDeclarations();
  const first = imports[0];
  if (first === undefined) {
    return undefined;
  }
  const statements = file.getStatementsWithComments();
  const last = imports.filter((declaration) => regionOf(declaration) === undefined).at(-1);
  if (last !== undefined) {
    return statements.indexOf(last) + 1;
  }
  const at = first.getStart();
  const start =
    regionsOf(file.getFullText()).find((region) => region.start <= at && at <= region.end)?.start ??
    at;
  return statements.findIndex((statement) => statement.getStart() >= start);
}

/** Whether an identifier refers to a binding, rather than naming a property or a member. */
function isReference(identifier: Node): boolean {
  const parent = identifier.getParent();
  if (parent === undefined) {
    return true;
  }
  if (Node.isPropertyAccessExpression(parent) || Node.isQualifiedName(parent)) {
    return parent.getFirstChild() === identifier;
  }
  if (
    Node.isPropertyAssignment(parent) ||
    Node.isPropertySignature(parent) ||
    Node.isPropertyDeclaration(parent) ||
    Node.isMethodDeclaration(parent) ||
    Node.isMethodSignature(parent) ||
    Node.isJsxAttribute(parent) ||
    Node.isBindingElement(parent)
  ) {
    // In `{ key: name = fallback }` only `key` names a property: a default (`{ a = LIMIT }`,
    // `[b = LIMIT]`) is a reference, and the binding's own name counts as one, conservatively.
    // A shorthand element (`{ a }`) has no property name, so every child of it counts.
    return Node.isBindingElement(parent)
      ? parent.getPropertyNameNode() !== identifier
      : parent.getNameNode() !== identifier;
  }
  return true;
}

/** The names the file uses outside its import declarations. */
function usedNames(file: SourceFile): Set<string> {
  const names = new Set<string>();
  for (const identifier of file.getDescendantsOfKind(SyntaxKind.Identifier)) {
    if (
      identifier.getFirstAncestorByKind(SyntaxKind.ImportDeclaration) === undefined &&
      isReference(identifier)
    ) {
      names.add(identifier.getText());
    }
  }
  return names;
}

/**
 * Removes the import specifiers the file no longer uses (and imports left
 * empty). Side-effect imports stay. With `only`, removes only those names.
 * The blank line between the imports and what opens the file (a directive,
 * a header comment) stays: it is the first import's leading trivia, which
 * removing that import would take with it.
 */
export function removeUnusedImports(file: SourceFile, only?: ReadonlySet<string>): void {
  const used = usedNames(file);
  const unused = (name: string): boolean =>
    !used.has(name) && (only === undefined || only.has(name));
  const opening = openingAboveImports(file);
  for (const declaration of file.getImportDeclarations()) {
    const named = declaration.getNamedImports();
    const defaultImport = declaration.getDefaultImport();
    const namespace = declaration.getNamespaceImport();
    if (named.length === 0 && defaultImport === undefined && namespace === undefined) {
      continue;
    }
    for (const specifier of named) {
      if (unused((specifier.getAliasNode() ?? specifier.getNameNode()).getText())) {
        specifier.remove();
      }
    }
    if (defaultImport !== undefined && unused(defaultImport.getText())) {
      declaration.removeDefaultImport();
    }
    if (namespace !== undefined && unused(namespace.getText())) {
      declaration.removeNamespaceImport();
    }
    const left =
      declaration.getNamedImports().length > 0 ||
      declaration.getDefaultImport() !== undefined ||
      declaration.getNamespaceImport() !== undefined;
    if (!left && !declaration.wasForgotten()) {
      declaration.remove();
    }
  }
  keepBlankLineUnder(file, opening);
}

/** Puts back the blank line under `opening` that removing the file's first import took with it. */
function keepBlankLineUnder(file: SourceFile, opening: string | undefined): void {
  if (opening === undefined) {
    return;
  }
  const text = file.getFullText();
  const rest = text.slice(opening.length);
  if (text.startsWith(opening) && rest.trim() !== "" && !/^[ \t]*\r?\n[ \t]*\r?\n/u.test(rest)) {
    file.insertText(opening.length, "\n");
  }
}

/**
 * The text that opens the file above its imports, up to the blank line that
 * separates the two, when one does: `"use client";`, or a header comment.
 */
function openingAboveImports(file: SourceFile): string | undefined {
  const first = file.getImportDeclarations()[0];
  if (first === undefined) {
    return undefined;
  }
  const above = file.getFullText().slice(0, first.getStart(true));
  const opening = above.trimEnd();
  return opening !== "" && /\n[ \t]*\r?\n\s*$/u.test(above) ? opening : undefined;
}

/**
 * An import whose names are all `type`-marked (`import { type A }`) becomes
 * `import type { A }`: only the inline markers would be erased, leaving an
 * import kept for its side effects (lint: no-import-type-side-effects).
 */
function typeOnlyImports(file: SourceFile): void {
  for (const declaration of file.getImportDeclarations()) {
    const named = declaration.getNamedImports();
    if (
      declaration.isTypeOnly() ||
      declaration.getDefaultImport() !== undefined ||
      declaration.getNamespaceImport() !== undefined ||
      named.length === 0 ||
      !named.every((specifier) => specifier.isTypeOnly())
    ) {
      continue;
    }
    for (const specifier of named) {
      specifier.setIsTypeOnly(false);
    }
    declaration.setIsTypeOnly(true);
  }
}

/**
 * The import cleanup every file the codemod writes or rewrites gets: the
 * imports it no longer uses go, and one left with only `type` names becomes
 * `import type`. A value import stays one, whatever its names are used as.
 */
export function tidyImports(file: SourceFile): void {
  removeUnusedImports(file);
  typeOnlyImports(file);
}

/**
 * The project's file a relative module specifier of `file` names (`./x.js`,
 * `./x`, `./dir`), read from its path: an empty file is no module, so the
 * type checker resolves no import of it.
 */
function relativeTarget(file: SourceFile, specifier: string): SourceFile | undefined {
  const base = resolve(dirname(file.getFilePath()), specifier).replace(/\.(?:m?js|jsx)$/u, "");
  const project = file.getProject();
  return [base, `${base}.ts`, `${base}.tsx`, `${base}/index.ts`, `${base}/index.tsx`]
    .map((candidate) => project.getSourceFile(candidate))
    .find((found) => found !== undefined);
}

/** Whether any file of the project imports or re-exports `file`, even a file left empty. */
export function isImported(project: Project, file: SourceFile): boolean {
  return project.getSourceFiles().some((other) =>
    [...other.getImportDeclarations(), ...other.getExportDeclarations()].some((declaration) => {
      const specifier = declaration.getModuleSpecifierValue();
      if (specifier === undefined) {
        return false;
      }
      return specifier.startsWith(".")
        ? relativeTarget(other, specifier) === file
        : declaration.getModuleSpecifierSourceFile() === file;
    }),
  );
}

/** The module `name` is imported from in `file`, and the name it is imported as. */
export function importOf(
  file: SourceFile,
  name: string,
): { readonly module: string; readonly imported: string } | undefined {
  for (const declaration of file.getImportDeclarations()) {
    for (const specifier of declaration.getNamedImports()) {
      const local = (specifier.getAliasNode() ?? specifier.getNameNode()).getText();
      if (local === name) {
        return { module: declaration.getModuleSpecifierValue(), imported: specifier.getName() };
      }
    }
  }
  return undefined;
}

/** Whether `node` is a reference to a binding imported from `module` (any entry when it ends in `*`). */
export function isImportedFrom(node: Node, module: string): boolean {
  if (!Node.isIdentifier(node)) {
    return false;
  }
  const found = importOf(node.getSourceFile(), node.getText());
  if (found === undefined) {
    return false;
  }
  return module.endsWith("*")
    ? found.module.startsWith(module.slice(0, -1))
    : found.module === module;
}
