// The services a parameter's type stands for, read from its source text:
// a method module's `service` parameter may be typed as the service class,
// or as a port of it (`Pick<BaseService<..., ChatServiceMethods, ...>,
// "defineMethod"> & { ... }`, an interface extending `Pick<ChatService, ...>`).
// The type checker cannot answer this: the codemod runs once the app is on
// 5.0, which has no `BaseService`.

import {
  type ClassDeclaration,
  type InterfaceDeclaration,
  Node,
  type TypeAliasDeclaration,
} from "ts-morph";
import { importOf } from "./imports";

export const CORE_SERVER = "@fitzzero/quickdraw-core/server";
export const BASES = new Set(["BaseService", "BaseRpcService"]);

/** The services, by leaf class, that each class of a chain belongs to, by declaration and by name. */
export interface ServiceIndex {
  readonly byClass: ReadonlyMap<ClassDeclaration, readonly ClassDeclaration[]>;
  readonly byName: ReadonlyMap<string, readonly ClassDeclaration[]>;
  /** The services by the method map of their `BaseService<...>`. */
  readonly byMethodMap: ReadonlyMap<string, readonly ClassDeclaration[]>;
}

/** TypeScript's own utility types, whose first type argument is the type they narrow. */
const UTILITIES = new Set(["Pick", "Omit", "Partial", "Readonly", "Required"]);
const LIB_FILE = /\/typescript\/lib\/lib\.[\w.]*d\.ts$/u;
const MAX_DEPTH = 12;

/** The declarations a name refers to, through its import. */
function declarationsOf(name: Node): Node[] {
  const symbol = name.getSymbol();
  const target = symbol?.isAlias() === true ? (symbol.getAliasedSymbol() ?? symbol) : symbol;
  return target?.getDeclarations() ?? [];
}

/**
 * The services a type stands for, read from its text: a service class (or a
 * class of its chain), `Pick`, `Omit`, `Partial`, `Readonly` or `Required` of
 * one, quickdraw's `BaseService<...>` over its method map, and the type
 * aliases, interfaces (their `extends`), type parameters (their constraint),
 * intersections and parentheses that lead to one. Not the type checker: the
 * codemod runs on 5.0, which has no `BaseService`.
 */
export function servicesOfType(
  node: Node | undefined,
  index: ServiceIndex,
  seen: Set<Node> = new Set(),
  depth = 0,
): ClassDeclaration[] {
  if (node === undefined || seen.has(node) || depth > MAX_DEPTH) {
    return [];
  }
  seen.add(node);
  const next = (child: Node | undefined): ClassDeclaration[] =>
    servicesOfType(child, index, seen, depth + 1);
  if (Node.isParenthesizedTypeNode(node)) {
    return next(node.getTypeNode());
  }
  if (Node.isIntersectionTypeNode(node)) {
    return node.getTypeNodes().flatMap(next);
  }
  if (Node.isTypeReference(node)) {
    return referenceServices(node.getTypeName(), node.getTypeArguments(), index, next);
  }
  if (Node.isExpressionWithTypeArguments(node)) {
    return referenceServices(node.getExpression(), node.getTypeArguments(), index, next);
  }
  if (Node.isTypeAliasDeclaration(node)) {
    return next(node.getTypeNode());
  }
  if (Node.isInterfaceDeclaration(node)) {
    return node.getExtends().flatMap(next);
  }
  if (Node.isTypeParameterDeclaration(node)) {
    return next(node.getConstraint());
  }
  if (Node.isClassDeclaration(node)) {
    return [...(index.byClass.get(node) ?? [])];
  }
  return [];
}

/** The services `name<args>` stands for. */
function referenceServices(
  name: Node,
  args: readonly Node[],
  index: ServiceIndex,
  next: (child: Node | undefined) => ClassDeclaration[],
): ClassDeclaration[] {
  const declarations = declarationsOf(name);
  if (!Node.isIdentifier(name)) {
    return declarations.flatMap(next);
  }
  const text = name.getText();
  const file = name.getSourceFile();
  const imported = importOf(file, text);
  if (imported?.module === CORE_SERVER && BASES.has(imported.imported)) {
    const map = args[imported.imported === "BaseRpcService" ? 0 : 3];
    const mapName =
      map !== undefined && Node.isTypeReference(map) && Node.isIdentifier(map.getTypeName())
        ? (importOf(file, map.getTypeName().getText())?.imported ?? map.getTypeName().getText())
        : map?.getText();
    return [...(index.byMethodMap.get(mapName ?? "") ?? [])];
  }
  if (
    UTILITIES.has(text) &&
    imported === undefined &&
    declarations.every((declaration) => LIB_FILE.test(declaration.getSourceFile().getFilePath()))
  ) {
    return next(args[0]);
  }
  if (declarations.length === 0) {
    return [...(index.byName.get(text) ?? [])];
  }
  return declarations.flatMap(next);
}

/** The type alias or interface a parameter's type names (through a type parameter's constraint), if any. */
export function portOf(
  node: Node | undefined,
  depth = 0,
): TypeAliasDeclaration | InterfaceDeclaration | undefined {
  if (node === undefined || depth > MAX_DEPTH) {
    return undefined;
  }
  if (Node.isTypeAliasDeclaration(node) || Node.isInterfaceDeclaration(node)) {
    return node;
  }
  if (Node.isTypeParameterDeclaration(node)) {
    return portOf(node.getConstraint(), depth + 1);
  }
  if (Node.isTypeReference(node)) {
    const [declaration] = declarationsOf(node.getTypeName());
    return portOf(declaration, depth + 1);
  }
  return undefined;
}
