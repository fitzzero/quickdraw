// The names a file binds, and how to rename one. The run writes names of its
// own into files (a service object's import, a method module's method
// objects, the service file's imports of them), and each must be free where
// it lands: `moduleBindings` and `nestedBindings` find what already binds a
// name, `freeName` finds one nothing uses, and `renameEdits` renames a
// binding and every reference to it, found by symbol, so a binding of the
// same name in another scope keeps its own.

import { type Identifier, Node, type SourceFile, type Statement, SyntaxKind } from "ts-morph";
import { applyEdits, type Edit } from "./text";

/** Whether `identifier` declares a binding (a variable, a parameter, an import, a function or class). */
export function declaresBinding(identifier: Identifier): boolean {
  const parent = identifier.getParent();
  if (
    Node.isVariableDeclaration(parent) ||
    Node.isParameterDeclaration(parent) ||
    Node.isBindingElement(parent) ||
    Node.isFunctionDeclaration(parent) ||
    Node.isClassDeclaration(parent) ||
    Node.isEnumDeclaration(parent) ||
    Node.isImportEqualsDeclaration(parent)
  ) {
    return parent.getNameNode() === identifier;
  }
  if (Node.isImportSpecifier(parent)) {
    return (parent.getAliasNode() ?? parent.getNameNode()) === identifier;
  }
  return Node.isImportClause(parent) || Node.isNamespaceImport(parent);
}

/** Whether `identifier` is the local name of an import. */
export function isImportBinding(identifier: Identifier): boolean {
  const parent = identifier.getParent();
  return (
    Node.isImportSpecifier(parent) ||
    Node.isImportClause(parent) ||
    Node.isNamespaceImport(parent) ||
    Node.isImportEqualsDeclaration(parent)
  );
}

/** Whether the file binds `name` anywhere. */
export function bindsName(file: SourceFile, name: string): boolean {
  return file
    .getDescendantsOfKind(SyntaxKind.Identifier)
    .some((identifier) => identifier.getText() === name && declaresBinding(identifier));
}

/** `base`, or `base2`, `base3`... the first the file does not use and `taken` does not hold. */
export function freeName(
  file: SourceFile,
  base: string,
  taken: ReadonlySet<string> = new Set(),
): string {
  const used = new Set(file.getDescendantsOfKind(SyntaxKind.Identifier).map((id) => id.getText()));
  let name = base;
  for (let index = 2; used.has(name) || taken.has(name); index += 1) {
    name = `${base}${String(index)}`;
  }
  return name;
}

/** The names a variable's name binds: itself, or each name of a destructuring pattern. */
function patternNames(name: Node): Identifier[] {
  if (Node.isIdentifier(name)) {
    return [name];
  }
  if (Node.isObjectBindingPattern(name) || Node.isArrayBindingPattern(name)) {
    return name
      .getElements()
      .flatMap((element) =>
        Node.isBindingElement(element) ? patternNames(element.getNameNode()) : [],
      );
  }
  return [];
}

/** The names a statement of the module scope binds there. */
function statementBindings(statement: Statement): Identifier[] {
  if (Node.isImportDeclaration(statement)) {
    return [
      statement.getDefaultImport(),
      statement.getNamespaceImport(),
      ...statement
        .getNamedImports()
        .map((specifier) => specifier.getAliasNode() ?? specifier.getNameNode()),
    ].filter((name): name is Identifier => Node.isIdentifier(name));
  }
  if (Node.isVariableStatement(statement)) {
    return statement
      .getDeclarations()
      .flatMap((declaration) => patternNames(declaration.getNameNode()));
  }
  if (
    Node.isFunctionDeclaration(statement) ||
    Node.isClassDeclaration(statement) ||
    Node.isEnumDeclaration(statement) ||
    Node.isImportEqualsDeclaration(statement) ||
    Node.isModuleDeclaration(statement)
  ) {
    const name = statement.getNameNode();
    return Node.isIdentifier(name) && name.getText() !== "global" ? [name] : [];
  }
  return [];
}

/**
 * The identifiers that bind `name` at module scope: an import's local name,
 * or a top-level declaration's, but those of the declarations in `except`.
 */
export function moduleBindings(
  file: SourceFile,
  name: string,
  except: ReadonlySet<Node> = new Set(),
): Identifier[] {
  return file
    .getStatements()
    .flatMap((statement) => statementBindings(statement))
    .filter(
      (identifier) => identifier.getText() === name && !except.has(identifier.getParentOrThrow()),
    );
}

/** Whether the binding `identifier` declares exists at runtime: a parameter of a type or a signature does not. */
function bindsAtRuntime(identifier: Identifier): boolean {
  const parameter = identifier.getFirstAncestorByKind(SyntaxKind.Parameter);
  const owner = parameter?.getParent();
  return (
    parameter === undefined || Node.isBodied(owner) || (Node.isBodyable(owner) && owner.hasBody())
  );
}

/**
 * The identifiers that bind a name below module scope, where they shadow a
 * binding of the module (a function's parameter or local, a destructured
 * name, a nested function or class), by name: one walk of the file.
 */
export function nestedBindings(file: SourceFile): Map<string, Identifier[]> {
  const topLevel = new Set(
    file.getStatements().flatMap((statement) => statementBindings(statement)),
  );
  const byName = new Map<string, Identifier[]>();
  for (const identifier of file.getDescendantsOfKind(SyntaxKind.Identifier)) {
    if (
      !topLevel.has(identifier) &&
      declaresBinding(identifier) &&
      !isImportBinding(identifier) &&
      bindsAtRuntime(identifier)
    ) {
      const name = identifier.getText();
      byName.set(name, [...(byName.get(name) ?? []), identifier]);
    }
  }
  return byName;
}

/** The local names `export { name }`, `export default name` and `export = name` export. */
function exportedLocals(file: SourceFile): Set<string> {
  const names = new Set<string>();
  for (const declaration of file.getExportDeclarations()) {
    if (!declaration.hasModuleSpecifier()) {
      for (const specifier of declaration.getNamedExports()) {
        names.add(specifier.getNameNode().getText());
      }
    }
  }
  for (const assignment of file.getExportAssignments()) {
    const expression = assignment.getExpression();
    if (Node.isIdentifier(expression)) {
      names.add(expression.getText());
    }
  }
  return names;
}

/** Whether the module-scope binding `identifier` names is exported: by `export` on its declaration, or by name. */
export function isExportedBinding(identifier: Identifier): boolean {
  const statement = identifier.getParentWhile((node) => !Node.isSourceFile(node));
  return (
    (Node.isExportGetable(statement) && statement.hasExportKeyword()) ||
    exportedLocals(identifier.getSourceFile()).has(identifier.getText())
  );
}

/** The names the file exports through `export { ... }` and `export * as name`, re-exports included. */
export function exportedNames(file: SourceFile): Set<string> {
  const names = new Set<string>();
  for (const declaration of file.getExportDeclarations()) {
    const namespace = declaration.getNamespaceExport();
    if (namespace !== undefined) {
      names.add(namespace.getName());
    }
    for (const specifier of declaration.getNamedExports()) {
      names.add((specifier.getAliasNode() ?? specifier.getNameNode()).getText());
    }
  }
  return names;
}

/** The binding an identifier refers to: a shorthand property's value, an export specifier's local. */
function referencedSymbol(identifier: Identifier): ReturnType<Identifier["getSymbol"]> {
  const parent = identifier.getParent();
  if (Node.isShorthandPropertyAssignment(parent)) {
    return parent.getValueSymbol();
  }
  if (Node.isExportSpecifier(parent) && parent.getNameNode() === identifier) {
    return parent.getLocalTargetSymbol();
  }
  return identifier.getSymbol();
}

/** `identifier` (a binding or a reference) written as `to`, keeping a key or an imported or exported name. */
function renamedText(identifier: Identifier, to: string): string {
  const name = identifier.getText();
  const parent = identifier.getParent();
  const shorthand =
    Node.isShorthandPropertyAssignment(parent) ||
    (Node.isBindingElement(parent) &&
      Node.isObjectBindingPattern(parent.getParent()) &&
      parent.getPropertyNameNode() === undefined &&
      parent.getDotDotDotToken() === undefined);
  if (shorthand) {
    return `${name}: ${to}`;
  }
  if (Node.isImportSpecifier(parent) && parent.getAliasNode() === undefined) {
    return `${name} as ${to}`;
  }
  if (Node.isExportSpecifier(parent) && parent.getAliasNode() === undefined) {
    return `${to} as ${name}`;
  }
  return to;
}

/**
 * The edits renaming the binding `declaration` declares, and every
 * reference to it in its file, to `to`. A shorthand property or destructured
 * name keeps its key (`{ name: to }`), an import its imported name
 * (`name as to`), and `export { name }` the name it exports (`to as name`).
 * No edit when the binding has no symbol: renaming only some of its uses
 * would break the rest.
 */
export function renameEdits(declaration: Identifier, to: string): Edit[] {
  const symbol = declaration.getSymbol();
  if (symbol === undefined) {
    return [];
  }
  const name = declaration.getText();
  return declaration
    .getSourceFile()
    .getDescendantsOfKind(SyntaxKind.Identifier)
    .filter(
      (identifier) => identifier.getText() === name && referencedSymbol(identifier) === symbol,
    )
    .map((identifier) => ({
      start: identifier.getStart(),
      end: identifier.getEnd(),
      text: renamedText(identifier, to),
    }));
}

/**
 * Renames of bindings, each to a name free in its file, computed on the files
 * as they are and written into them together by `apply`.
 */
export class Renames {
  readonly edits = new Map<SourceFile, Edit[]>();
  private readonly taken = new Map<SourceFile, Set<string>>();
  private readonly renamed = new Set<Identifier>();
  private readonly nested = new Map<SourceFile, Map<string, Identifier[]>>();

  /** The bindings of `name` below the module scope of `file`, read once per file: no file changes before `apply`. */
  nestedIn(file: SourceFile, name: string): Identifier[] {
    const byName = this.nested.get(file) ?? nestedBindings(file);
    this.nested.set(file, byName);
    return byName.get(name) ?? [];
  }

  /** The names no rename may take in `file`, `names` added: the run writes them there, or a rename took them. */
  reserve(file: SourceFile, names: readonly string[] = []): Set<string> {
    const taken = this.taken.get(file) ?? new Set<string>();
    this.taken.set(file, taken);
    for (const name of names) {
      taken.add(name);
    }
    return taken;
  }

  /** Renames the binding `binding` declares (once) to `base`, or the first free name after it. */
  rename(binding: Identifier, base: string): void {
    if (this.renamed.has(binding)) {
      return;
    }
    this.renamed.add(binding);
    const file = binding.getSourceFile();
    const taken = this.reserve(file);
    const to = freeName(file, base, taken);
    taken.add(to);
    const edits = renameEdits(binding, to);
    if (edits.length > 0) {
      this.edits.set(file, [...(this.edits.get(file) ?? []), ...edits]);
    }
  }

  /** Writes the renames into their files; whether there were any. */
  apply(): boolean {
    for (const [file, edits] of this.edits) {
      file.replaceWithText(applyEdits(file.getFullText(), 0, edits));
    }
    return this.edits.size > 0;
  }
}
