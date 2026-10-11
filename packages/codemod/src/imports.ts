// Imports the transforms add and remove. New relative imports follow the
// package's own habit: with a `.js` extension where its relative imports
// have one (NodeNext packages), without where they do not (bundlers).

import { dirname, relative, resolve } from "node:path";
import { Node, SyntaxKind, type Project, type SourceFile } from "ts-morph";
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

/** Adds `name` to the file's import from `module`, creating the import when needed. */
export function ensureImport(
  file: SourceFile,
  module: string,
  name: string,
  options: { readonly typeOnly?: boolean } = {},
): void {
  const typeOnly = options.typeOnly === true;
  const bound = file
    .getImportDeclarations()
    .some(
      (declaration) =>
        declaration.getModuleSpecifierValue() === module &&
        declaration
          .getNamedImports()
          .some(
            (specifier) => (specifier.getAliasNode() ?? specifier.getNameNode()).getText() === name,
          ),
    );
  if (bound) {
    // Already imported, as a value or a type (`import { type X }` included).
    return;
  }
  const existing = file
    .getImportDeclarations()
    .find(
      (declaration) =>
        declaration.getModuleSpecifierValue() === module &&
        declaration.getNamespaceImport() === undefined &&
        declaration.isTypeOnly() === typeOnly,
    );
  if (existing !== undefined) {
    if (!existing.getNamedImports().some((specifier) => specifier.getName() === name)) {
      existing.addNamedImport(name);
    }
    return;
  }
  const index = file.getImportDeclarations().length;
  file.insertImportDeclaration(index, {
    moduleSpecifier: module,
    namedImports: [name],
    isTypeOnly: typeOnly,
  });
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
    return Node.isBindingElement(parent)
      ? parent.getNameNode() === identifier
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
 */
export function removeUnusedImports(file: SourceFile, only?: ReadonlySet<string>): void {
  const used = usedNames(file);
  const unused = (name: string): boolean =>
    !used.has(name) && (only === undefined || only.has(name));
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
