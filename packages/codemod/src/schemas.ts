// Moving a method's Zod schema into the shared package. The schema passed as
// `defineMethod(..., { schema })` becomes the contract method's `input`, with
// every declaration it depends on: consts and functions of the service file
// go into the contract file, those of other api files (the template's
// `cuidSchema`, `byIdSchema`) into `contracts/helpers.ts`. A schema that
// depends on anything else (another package, a type, a class) stays where
// it is, and the contract gets a `todoSchema` instead. Each moved piece of
// code records where it names a moved declaration (directly, or through an
// import or re-export alias), so the contract can write it under the name
// the contract binds.

import {
  type FunctionDeclaration,
  type Identifier,
  type ImportSpecifier,
  Node,
  type SourceFile,
  SyntaxKind,
  type VariableDeclaration,
} from "ts-morph";

/** Where moved code names a moved declaration: `code.slice(start, end)`, the declaration of `key`. */
export interface Reference {
  readonly start: number;
  readonly end: number;
  readonly key: string;
}

/** A declaration the moved schema needs. */
export interface MovedDeclaration {
  /** `<file>#<name>`: the same helper reached twice is written once. */
  readonly key: string;
  readonly name: string;
  /** The file it is declared in. */
  readonly file: string;
  /** Its statement, without `export`, and the JSDoc above it. */
  readonly code: string;
  readonly docs: string;
  /** Where `code` names moved declarations, its own name included. */
  readonly references: readonly Reference[];
  /** `local` (from the service file: into the contract file) or `helper` (into helpers.ts). */
  readonly place: "local" | "helper";
}

/** A schema that can move: the code to use as `input`, and what must come with it. */
export interface MovedSchema {
  /** The 4.x schema's text, which may name a declaration by an alias: write it through `references`. */
  readonly code: string;
  /** Where `code` names moved declarations. */
  readonly references: readonly Reference[];
  /** Dependencies first. */
  readonly declarations: readonly MovedDeclaration[];
  /** The helpers the contract file itself refers to (its code and its local declarations). */
  readonly directHelpers: readonly string[];
  /** Zod imports as `{ statement, local }`. */
  readonly zod: readonly { readonly statement: string; readonly local: string }[];
}

export type SchemaMove =
  | { readonly ok: true; readonly schema: MovedSchema }
  | { readonly ok: false; readonly reason: string };

type Movable = VariableDeclaration | FunctionDeclaration;

/** The code being walked: `base` is the file offset of its first character. */
interface Owner {
  readonly base: number;
  readonly length: number;
  readonly references: Reference[];
}

const ZOD = /^zod(\/.*)?$/u;

class Closure {
  readonly declarations: MovedDeclaration[] = [];
  readonly zod = new Map<string, string>();
  readonly direct = new Set<string>();
  private readonly visited = new Set<string>();
  problem: string | undefined;

  constructor(private readonly serviceFile: SourceFile) {}

  /**
   * Walks `root` (inside a declaration of `place`, or the schema itself when
   * `place` is undefined), recording its references in `owner`.
   */
  walk(root: Node, place: "local" | "helper" | undefined, owner: Owner): void {
    const identifiers = Node.isIdentifier(root)
      ? [root]
      : root.getDescendantsOfKind(SyntaxKind.Identifier);
    for (const identifier of identifiers) {
      if (this.problem === undefined) {
        this.visit(identifier, root, place, owner);
      }
    }
  }

  private visit(
    identifier: Identifier,
    root: Node,
    place: "local" | "helper" | undefined,
    owner: Owner,
  ): void {
    const declaration = identifier.getSymbol()?.getDeclarations()[0];
    if (declaration === undefined) {
      return;
    }
    if (isWithin(declaration, root)) {
      // a function that calls itself
      if (declaration === root && Node.isFunctionDeclaration(root)) {
        refer(owner, identifier, keyOf(root));
      }
      return;
    }
    // a library's own declarations: zod's members, globals
    if (
      declaration.getSourceFile().isInNodeModules() ||
      declaration.getSourceFile().isDeclarationFile()
    ) {
      return;
    }
    if (
      Node.isImportSpecifier(declaration) ||
      Node.isNamespaceImport(declaration) ||
      Node.isImportClause(declaration)
    ) {
      this.visitImport(identifier, declaration, place, owner);
      return;
    }
    if (isModuleLevel(declaration)) {
      refer(owner, identifier, keyOf(declaration));
      this.add(declaration, place);
      return;
    }
    if (!isProperty(declaration)) {
      this.problem = `it uses \`${identifier.getText()}\`, which is not a module-level const or function`;
    }
  }

  private visitImport(
    identifier: Identifier,
    declaration: Node,
    place: "local" | "helper" | undefined,
    owner: Owner,
  ): void {
    const statement = declaration.getFirstAncestorByKind(SyntaxKind.ImportDeclaration);
    const source = statement?.getModuleSpecifierValue() ?? "";
    if (ZOD.test(source) && statement !== undefined) {
      const text = statement.getText();
      this.zod.set(
        identifier.getText(),
        Node.isImportSpecifier(declaration) ? namedImport(declaration, source) : text,
      );
      return;
    }
    const target = identifier.getSymbol()?.getAliasedSymbol()?.getDeclarations()[0];
    if (!source.startsWith(".") || target === undefined || !isModuleLevel(target)) {
      this.problem = `it uses \`${identifier.getText()}\` from "${source}", which cannot move to the shared package`;
      return;
    }
    // the declaration's own name, which the contract binds, not the alias
    refer(owner, identifier, keyOf(target));
    this.add(target, place);
  }

  private add(declaration: Movable, from: "local" | "helper" | undefined): void {
    const file = declaration.getSourceFile();
    const place = file === this.serviceFile ? "local" : "helper";
    const name = declaration.getName() ?? "";
    if (place === "helper" && from !== "helper") {
      this.direct.add(name);
    }
    const key = keyOf(declaration);
    if (this.visited.has(key)) {
      return;
    }
    this.visited.add(key);
    const { docs, code, base } = statementText(declaration);
    const owner: Owner = { base, length: code.length, references: [] };
    const nameNode = declaration.getNameNode();
    if (nameNode !== undefined && Node.isIdentifier(nameNode)) {
      refer(owner, nameNode, key);
    }
    this.walk(
      Node.isVariableDeclaration(declaration)
        ? (declaration.getInitializer() ?? declaration)
        : declaration,
      place,
      owner,
    );
    this.declarations.push({
      key,
      name,
      file: file.getFilePath(),
      code,
      docs,
      references: owner.references.toSorted((a, b) => a.start - b.start),
      place,
    });
  }
}

function keyOf(declaration: Movable): string {
  return `${declaration.getSourceFile().getFilePath()}#${declaration.getName() ?? ""}`;
}

/** Records that `identifier`, inside `owner`'s code, names the declaration of `key`. */
function refer(owner: Owner, identifier: Identifier, key: string): void {
  const start = identifier.getStart() - owner.base;
  const end = identifier.getEnd() - owner.base;
  // a JSDoc's {@link} lies outside the code; a function's own name is met twice
  if (
    start >= 0 &&
    end <= owner.length &&
    !owner.references.some((reference) => reference.start === start)
  ) {
    owner.references.push({ start, end, key });
  }
}

function namedImport(specifier: ImportSpecifier, source: string): string {
  const alias = specifier.getAliasNode()?.getText();
  const name = specifier.getName();
  return `import { ${alias === undefined ? name : `${name} as ${alias}`} } from "${source}";`;
}

function isWithin(node: Node, root: Node): boolean {
  return (
    node.getSourceFile() === root.getSourceFile() &&
    node.getStart() >= root.getStart() &&
    node.getEnd() <= root.getEnd()
  );
}

function isModuleLevel(node: Node): node is Movable {
  if (Node.isFunctionDeclaration(node)) {
    return node.getParent() !== undefined && Node.isSourceFile(node.getParent());
  }
  if (!Node.isVariableDeclaration(node)) {
    return false;
  }
  const statement = node.getVariableStatement();
  return statement !== undefined && Node.isSourceFile(statement.getParent());
}

function isProperty(node: Node): boolean {
  return (
    Node.isPropertyAssignment(node) ||
    Node.isPropertySignature(node) ||
    Node.isPropertyDeclaration(node) ||
    Node.isMethodDeclaration(node) ||
    Node.isMethodSignature(node) ||
    Node.isShorthandPropertyAssignment(node) ||
    Node.isParameterDeclaration(node) ||
    Node.isBindingElement(node)
  );
}

/**
 * A declaration's statement, as its own `const` (or function) without
 * `export`, and its JSDoc; `base` is the file offset of the code's first
 * character, which may lie before the declaration (the `const` it writes).
 */
function statementText(declaration: Movable): { docs: string; code: string; base: number } {
  const statement = Node.isFunctionDeclaration(declaration)
    ? declaration
    : declaration.getVariableStatement();
  const docs =
    statement
      ?.getJsDocs()
      .map((doc) => doc.getText())
      .join("\n") ?? "";
  if (Node.isFunctionDeclaration(declaration)) {
    const start = declaration.getStart() - declaration.getStart(true);
    const text = declaration.getText(true).slice(start);
    const code = text.replace(/^export\s+/u, "");
    return { docs, code, base: declaration.getStart() + text.length - code.length };
  }
  const kind =
    statement === undefined || !Node.isVariableStatement(statement)
      ? "const"
      : statement.getDeclarationKind();
  return {
    docs,
    code: `${kind} ${declaration.getText()};`,
    base: declaration.getStart() - kind.length - 1,
  };
}

/** Moves `schema` (the `schema:` option of a defineMethod call in `serviceFile`), or says why it cannot. */
export function moveSchema(schema: Node, serviceFile: SourceFile): SchemaMove {
  const closure = new Closure(serviceFile);
  const code = schema.getText();
  const owner: Owner = { base: schema.getStart(), length: code.length, references: [] };
  closure.walk(schema, undefined, owner);
  if (closure.problem !== undefined) {
    return { ok: false, reason: closure.problem };
  }
  return {
    ok: true,
    schema: {
      code,
      references: owner.references.toSorted((a, b) => a.start - b.start),
      declarations: closure.declarations,
      directHelpers: [...closure.direct],
      zod: [...closure.zod.entries()].map(([localName, statement]) => ({
        statement,
        local: localName,
      })),
    },
  };
}
