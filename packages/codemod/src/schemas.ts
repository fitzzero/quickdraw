// Moving a method's Zod schema into the shared package. The schema passed as
// `defineMethod(..., { schema })` becomes the contract method's `input`, with
// every declaration it depends on: consts and functions of the service file
// go into the contract file, those of other api files (the template's
// `cuidSchema`, `byIdSchema`) into `contracts/helpers.ts`. A schema that
// depends on anything else (another package, a type, a class) stays where
// it is, and the contract gets a `todoSchema` instead.

import {
  type FunctionDeclaration,
  type Identifier,
  type ImportSpecifier,
  Node,
  type SourceFile,
  SyntaxKind,
  type VariableDeclaration,
} from "ts-morph";

/** A declaration the moved schema needs. */
export interface MovedDeclaration {
  /** `<file>#<name>`: the same helper reached twice is written once. */
  readonly key: string;
  readonly name: string;
  /** Its statement, without `export`, and the JSDoc above it. */
  readonly code: string;
  readonly docs: string;
  /** `local` (from the service file: into the contract file) or `helper` (into helpers.ts). */
  readonly place: "local" | "helper";
}

/** A schema that can move: the code to use as `input`, and what must come with it. */
export interface MovedSchema {
  readonly code: string;
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

const ZOD = /^zod(\/.*)?$/u;

class Closure {
  readonly declarations: MovedDeclaration[] = [];
  readonly zod = new Map<string, string>();
  readonly direct = new Set<string>();
  private readonly visited = new Set<string>();
  problem: string | undefined;

  constructor(private readonly serviceFile: SourceFile) {}

  /** Walks `root` (inside a declaration of `place`, or the schema itself when `place` is undefined). */
  walk(root: Node, place: "local" | "helper" | undefined): void {
    const identifiers = Node.isIdentifier(root)
      ? [root]
      : root.getDescendantsOfKind(SyntaxKind.Identifier);
    for (const identifier of identifiers) {
      if (this.problem === undefined) {
        this.visit(identifier, root, place);
      }
    }
  }

  private visit(identifier: Identifier, root: Node, place: "local" | "helper" | undefined): void {
    const declaration = identifier.getSymbol()?.getDeclarations()[0];
    if (declaration === undefined || isWithin(declaration, root)) {
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
      this.visitImport(identifier, declaration, place);
      return;
    }
    if (isModuleLevel(declaration)) {
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
    this.add(target, place);
  }

  private add(declaration: Movable, from: "local" | "helper" | undefined): void {
    const file = declaration.getSourceFile();
    const place = file === this.serviceFile ? "local" : "helper";
    const name = declaration.getName() ?? "";
    if (place === "helper" && from !== "helper") {
      this.direct.add(name);
    }
    const key = `${file.getFilePath()}#${name}`;
    if (this.visited.has(key)) {
      return;
    }
    this.visited.add(key);
    this.walk(
      Node.isVariableDeclaration(declaration)
        ? (declaration.getInitializer() ?? declaration)
        : declaration,
      place,
    );
    this.declarations.push({ key, name, ...statementText(declaration), place });
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

/** A declaration's statement, as its own `const` (or function) without `export`, and its JSDoc. */
function statementText(declaration: Movable): { docs: string; code: string } {
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
    return {
      docs,
      code: declaration
        .getText(true)
        .slice(start)
        .replace(/^export\s+/u, ""),
    };
  }
  const kind =
    statement === undefined || !Node.isVariableStatement(statement)
      ? "const"
      : statement.getDeclarationKind();
  return { docs, code: `${kind} ${declaration.getText()};` };
}

/** Moves `schema` (the `schema:` option of a defineMethod call in `serviceFile`), or says why it cannot. */
export function moveSchema(schema: Node, serviceFile: SourceFile): SchemaMove {
  const closure = new Closure(serviceFile);
  closure.walk(schema, undefined);
  if (closure.problem !== undefined) {
    return { ok: false, reason: closure.problem };
  }
  return {
    ok: true,
    schema: {
      code: schema.getText(),
      declarations: closure.declarations,
      directHelpers: [...closure.direct],
      zod: [...closure.zod.entries()].map(([localName, statement]) => ({
        statement,
        local: localName,
      })),
    },
  };
}
