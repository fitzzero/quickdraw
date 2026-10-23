// What the migrated code gives a function as its Prisma client, read from
// the code: the tracked client (a handler's `db`, a client `trackPrisma`
// made, which the api's `db.ts` exports, or a binding typed with quickdraw's
// `Tracked` or `TrackedTransaction`), the client of an interactive
// transaction on one of those, a parameter whose own callers decide, or
// anything else. `helperClients` types writers from it.

import { Node, SyntaxKind, type TypeNode } from "ts-morph";

export const PRISMA_MODULE = "@fitzzero/quickdraw-core/prisma";

/** The modules quickdraw's `Tracked`, `TrackedTransaction` and `trackPrisma` come from. */
export const QUICKDRAW_MODULES: ReadonlySet<string> = new Set([
  "@fitzzero/quickdraw-core",
  PRISMA_MODULE,
]);

/** What an argument gives as the Prisma client. */
export type Given<P> =
  | { readonly kind: "untracked" }
  | { readonly kind: "root" }
  /** A transaction's client: of a parameter when `of` is set, which must be given the tracked client. */
  | { readonly kind: "transaction"; readonly of: P | undefined }
  /** A parameter, which is the tracked client when its own callers give it one. */
  | { readonly kind: "parameter"; readonly of: P };

/** `node` inside its parentheses, `as`, `satisfies` and `!`. */
export function unwrapped(node: Node | undefined): Node | undefined {
  let current = node;
  while (
    Node.isParenthesizedExpression(current) ||
    Node.isAsExpression(current) ||
    Node.isSatisfiesExpression(current) ||
    Node.isNonNullExpression(current)
  ) {
    current = current.getExpression();
  }
  return current;
}

/** The declarations `identifier` refers to, through imports to what they import. */
export function declarationsOf(identifier: Node): Node[] {
  const symbol = identifier.getSymbol();
  return (symbol?.getAliasedSymbol() ?? symbol)?.getDeclarations() ?? [];
}

/** The module and the name `identifier` is imported under, when an import binds it. */
function importOf(identifier: Node): { source: string; name: string } | undefined {
  for (const declaration of identifier.getSymbol()?.getDeclarations() ?? []) {
    if (Node.isImportSpecifier(declaration)) {
      return {
        source: declaration.getImportDeclaration().getModuleSpecifierValue(),
        name: declaration.getName(),
      };
    }
  }
  return undefined;
}

/** Whether `type` is quickdraw's `Tracked` (root) or `TrackedTransaction` (transaction), imported under any name. */
function trackedType(type: TypeNode | undefined): "root" | "transaction" | undefined {
  if (!Node.isTypeReference(type)) {
    return undefined;
  }
  const name = type.getTypeName();
  let imported: string | undefined;
  if (Node.isIdentifier(name)) {
    const found = importOf(name);
    imported = found !== undefined && QUICKDRAW_MODULES.has(found.source) ? found.name : undefined;
  } else {
    const namespace = name.getLeft();
    const declaration = Node.isIdentifier(namespace)
      ? namespace.getSymbol()?.getDeclarations()[0]
      : undefined;
    const source = Node.isNamespaceImport(declaration)
      ? declaration.getFirstAncestorByKind(SyntaxKind.ImportDeclaration)?.getModuleSpecifierValue()
      : undefined;
    imported =
      source !== undefined && QUICKDRAW_MODULES.has(source) ? name.getRight().getText() : undefined;
  }
  if (imported === "Tracked") {
    return "root";
  }
  return imported === "TrackedTransaction" ? "transaction" : undefined;
}

/** Whether `declaration` is a variable `trackPrisma(...)` made. */
function madeByTrackPrisma(declaration: Node): boolean {
  if (!Node.isVariableDeclaration(declaration)) {
    return false;
  }
  const initializer = unwrapped(declaration.getInitializer());
  if (!Node.isCallExpression(initializer)) {
    return false;
  }
  const found = importOf(initializer.getExpression());
  return found !== undefined && QUICKDRAW_MODULES.has(found.source) && found.name === "trackPrisma";
}

/** Whether `declaration` is a handler's `db`: `handler: async ({ input, db }) => ...`. */
function isHandlerDb(declaration: Node): boolean {
  if (!Node.isBindingElement(declaration)) {
    return false;
  }
  const key = declaration.getPropertyNameNode()?.getText() ?? declaration.getName();
  const param = declaration.getParent().getParent();
  const fn = param.getParent();
  if (key !== "db" || !Node.isParameterDeclaration(param) || fn === undefined) {
    return false;
  }
  const first =
    (Node.isArrowFunction(fn) || Node.isFunctionExpression(fn) || Node.isMethodDeclaration(fn)) &&
    fn.getParameters()[0] === param;
  if (!first) {
    return false;
  }
  if (Node.isMethodDeclaration(fn)) {
    return fn.getName() === "handler";
  }
  const property = fn.getParent();
  return Node.isPropertyAssignment(property) && property.getName() === "handler";
}

/** The receiver of the `$transaction` call whose callback's first parameter `declaration` is. */
function transactionOf(declaration: Node): Node | undefined {
  if (!Node.isParameterDeclaration(declaration)) {
    return undefined;
  }
  const callback = declaration.getParent();
  const call = callback.getParent();
  if (
    !(Node.isArrowFunction(callback) || Node.isFunctionExpression(callback)) ||
    callback.getParameters()[0] !== declaration ||
    !Node.isCallExpression(call) ||
    call.getArguments()[0] !== callback
  ) {
    return undefined;
  }
  const callee = call.getExpression();
  return Node.isPropertyAccessExpression(callee) && callee.getName() === "$transaction"
    ? callee.getExpression()
    : undefined;
}

/**
 * What `argument` gives as the Prisma client: the tracked client (`root`), a
 * transaction's client of one, a parameter `parameterOf` names (whose own
 * callers decide), or anything else (`untracked`).
 */
export function givenBy<P>(
  argument: Node | undefined,
  parameterOf: (declaration: Node) => P | undefined,
): Given<P> {
  const value = unwrapped(argument);
  if (!Node.isIdentifier(value)) {
    return { kind: "untracked" };
  }
  for (const declaration of declarationsOf(value)) {
    const parameter = parameterOf(declaration);
    if (parameter !== undefined) {
      return { kind: "parameter", of: parameter };
    }
    if (madeByTrackPrisma(declaration) || isHandlerDb(declaration)) {
      return { kind: "root" };
    }
    if (Node.isParameterDeclaration(declaration) || Node.isVariableDeclaration(declaration)) {
      const typed = trackedType(declaration.getTypeNode());
      if (typed !== undefined) {
        return typed === "root" ? { kind: "root" } : { kind: "transaction", of: undefined };
      }
    }
    const receiver = transactionOf(declaration);
    if (receiver !== undefined) {
      const around = givenBy(receiver, parameterOf);
      switch (around.kind) {
        case "untracked":
          return around;
        case "root":
          return { kind: "transaction", of: undefined };
        default:
          return { kind: "transaction", of: around.of };
      }
    }
  }
  return { kind: "untracked" };
}
