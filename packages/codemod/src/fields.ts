// What a 4.x service class's fields are, for hoisting (`hoist.ts`): which
// become module bindings (all but the Prisma client's and one holding
// another service), which names the members' own locals take (a hoisted
// binding must not be shadowed where it is read), and how the class writes
// each field (only in its initializer, by its constructor, or later).

import {
  type ClassDeclaration,
  Node,
  type PropertyDeclaration,
  type Statement,
  SyntaxKind,
} from "ts-morph";
import { isServiceClass, type ServiceModel } from "./model";

/** Whether a property's initializer is a function: it is hoisted like a method. */
export function isFunctionProperty(property: PropertyDeclaration): boolean {
  const init = property.getInitializer();
  return init !== undefined && (Node.isArrowFunction(init) || Node.isFunctionExpression(init));
}

/** Whether a field holds another 4.x service (`chatService: ChatService | undefined`). */
function holdsService(property: PropertyDeclaration): boolean {
  const declaration = property.getType().getNonNullableType().getSymbol()?.getDeclarations()[0];
  return declaration !== undefined && Node.isClassDeclaration(declaration)
    ? isServiceClass(declaration)
    : false;
}

/** The fields of the chain that become module bindings: not static, not the Prisma client, not a service. */
export function keptFields(cls: ClassDeclaration, service: ServiceModel): PropertyDeclaration[] {
  return cls
    .getProperties()
    .filter(
      (property) =>
        !property.isStatic() &&
        !isFunctionProperty(property) &&
        !service.prismaFields.has(property.getName()) &&
        !holdsService(property),
    );
}

/**
 * The names the chain's classes bind inside their members (variables,
 * parameters, destructured names): a member hoisted under one of them would
 * be shadowed where code reads it (`const transport = this.transport`).
 */
export function localNames(service: ServiceModel): Set<string> {
  return new Set(
    service.chain.flatMap((cls) =>
      [
        ...cls.getDescendantsOfKind(SyntaxKind.VariableDeclaration),
        ...cls.getDescendantsOfKind(SyntaxKind.Parameter),
        ...cls.getDescendantsOfKind(SyntaxKind.BindingElement),
      ]
        .map((declaration) => declaration.getNameNode())
        .filter((name) => Node.isIdentifier(name))
        .map((name) => name.getText()),
    ),
  );
}

/** The member `this.<name> = ...` assigns, when the statement is such an assignment. */
export function assignedMember(statement: Statement): string | undefined {
  if (!Node.isExpressionStatement(statement)) {
    return undefined;
  }
  const expression = statement.getExpression();
  if (!Node.isBinaryExpression(expression) || expression.getOperatorToken().getText() !== "=") {
    return undefined;
  }
  const left = expression.getLeft();
  return Node.isPropertyAccessExpression(left) &&
    left.getExpression().getKind() === SyntaxKind.ThisKeyword
    ? left.getName()
    : undefined;
}

/** Whether `this.<name>` is written anywhere in the chain but its own initializer. */
export function reassigned(service: ServiceModel, name: string): boolean {
  return service.chain.some((cls) =>
    cls.getDescendantsOfKind(SyntaxKind.PropertyAccessExpression).some((access) => {
      if (
        access.getName() !== name ||
        access.getExpression().getKind() !== SyntaxKind.ThisKeyword
      ) {
        return false;
      }
      const parent = access.getParent();
      if (Node.isBinaryExpression(parent) && parent.getLeft() === access) {
        const operator = parent.getOperatorToken().getKind();
        return operator >= SyntaxKind.FirstAssignment && operator <= SyntaxKind.LastAssignment;
      }
      return Node.isPrefixUnaryExpression(parent) || Node.isPostfixUnaryExpression(parent);
    }),
  );
}

/** Whether the chain's constructors assign `this.<name>`. */
export function setByConstructor(service: ServiceModel, name: string): boolean {
  return service.chain.some((cls) =>
    cls
      .getConstructors()
      .some((ctor) => ctor.getStatements().some((statement) => assignedMember(statement) === name)),
  );
}
