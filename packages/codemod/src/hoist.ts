// What happens to the rest of a 4.x service class. A service object has no
// members, so each member becomes module-level code in the class's file:
// helper methods become functions (exported when they were public, since
// other files may call them), overridden 4.x hooks become functions under a
// marker, `defineCollection` and `installAdminMethods` options become consts
// under a marker, and any other constructor code goes into a marked setup
// function. Nothing the codemod cannot translate is deleted.

import {
  type ClassDeclaration,
  type ConstructorDeclaration,
  type MethodDeclaration,
  Node,
  type Statement,
} from "ts-morph";
import { type Category, MarkerSet, markerText } from "./markers";
import type { ServiceModel } from "./model";
import { type Hoisted, mapReceiver, type ReceiverScope } from "./receiver";
import { editedText, statementOf } from "./text";

/** The marker each overridden 4.x hook gets, by name. */
const HOOK_NOTES: Readonly<Record<string, { category: Category; message: string }>> = {
  checkAccess: {
    category: "access-override",
    message:
      "4.x access override: port it to the service's access policy (owner, jsonAcl, members, inherit, anyOf or resolver), then delete this function",
  },
  checkEntryACL: {
    category: "access-override",
    message:
      "4.x access override: port it to the service's access policy (owner, jsonAcl, members, inherit, anyOf or resolver), then delete this function",
  },
  checkSubscriptionAccess: {
    category: "access-override",
    message:
      "4.x subscription access override: subscriptions use the service's policy in 5.0; port it there, then delete this function",
  },
  checkBatchSubscriptionAccess: {
    category: "access-override",
    message:
      "4.x subscription access override: subscriptions use the service's policy in 5.0; port it there, then delete this function",
  },
  hasServiceAccess: {
    category: "access-override",
    message:
      "4.x service-grant override: 5.0 reads grants from principal.serviceAccess; port it to the policy or the method forms, then delete this function",
  },
  toDto: {
    category: "projection",
    message:
      "4.x toDto: subscribers now receive the contract entity's keys, projected from the row (dates as ISO strings); fold computed fields into a projection's select and map, then delete this function",
  },
  getProtectedFields: {
    category: "projection",
    message:
      'protected fields: declare them in the contract\'s fields with the level that may read each one (fields: { email: "Admin" }), then delete this function',
  },
  hasElevatedAccess: {
    category: "projection",
    message:
      "who saw protected fields: in 5.0 the contract's fields levels decide it per row; delete this function once they are declared",
  },
  beforeCreate: {
    category: "lifecycle",
    message:
      "4.x lifecycle hook, run only by this.create: move what it does into the methods that create rows, then delete it",
  },
  afterCreate: {
    category: "lifecycle",
    message:
      "4.x lifecycle hook, run only by this.create: move what it does into the methods that create rows (or affects, for rows of other services), then delete it",
  },
  beforeUpdate: {
    category: "lifecycle",
    message:
      "4.x lifecycle hook, run only by this.update: move what it does into the methods that update rows, then delete it",
  },
  afterUpdate: {
    category: "lifecycle",
    message:
      "4.x lifecycle hook, run only by this.update: move what it does into the methods that update rows (or affects), then delete it",
  },
  beforeDelete: {
    category: "lifecycle",
    message:
      "4.x lifecycle hook, run only by this.delete: move what it does into the methods that delete rows, then delete it",
  },
  afterDelete: {
    category: "lifecycle",
    message:
      "4.x lifecycle hook, run only by this.delete: move what it does into the methods that delete rows (or affects), then delete it",
  },
};

const CONSTRUCTION = new Set(["setDelegate", "verifyAllMethods", "defineMethod"]);

/** Names a hoisted function may not take in the service file. */
const RESERVED = new Set(["qd", "db", "input", "ctx"]);

/** `this.<name>(...)` as a statement: its name, or undefined. */
function thisCallName(statement: Statement): string | undefined {
  const expression = Node.isExpressionStatement(statement) ? statement.getExpression() : undefined;
  if (expression === undefined || !Node.isCallExpression(expression)) {
    return undefined;
  }
  const callee = expression.getExpression();
  return Node.isPropertyAccessExpression(callee) && callee.getExpression().getText() === "this"
    ? callee.getName()
    : undefined;
}

/**
 * Whether a statement only sets the 4.x service up and vanishes: a
 * `defineMethod` call the codemod moved, `setDelegate`, `verifyAllMethods`,
 * a call of a set-up-only method, or `registerX(this)`.
 */
function isSetup(
  statement: Statement,
  service: ServiceModel,
  setupOnly: ReadonlySet<string>,
): boolean {
  const name = thisCallName(statement);
  if (name === "defineMethod") {
    const expression = Node.isExpressionStatement(statement)
      ? statement.getExpression()
      : undefined;
    return service.methods.some((method) => method.call === expression);
  }
  return (
    (name !== undefined && (CONSTRUCTION.has(name) || setupOnly.has(name))) ||
    isRegisterCall(statement)
  );
}

/** `registerX(this)` as a statement. */
export function isRegisterCall(statement: Statement): boolean {
  const expression = Node.isExpressionStatement(statement) ? statement.getExpression() : undefined;
  return (
    expression !== undefined &&
    Node.isCallExpression(expression) &&
    Node.isIdentifier(expression.getExpression()) &&
    expression.getArguments().length === 1 &&
    expression.getArguments()[0]?.getText() === "this"
  );
}

/** The methods whose bodies only define methods, call such methods, or verify them: they vanish. */
export function setupOnlyMethods(service: ServiceModel): Set<string> {
  const methods = service.chain.flatMap((cls) => cls.getMethods());
  const only = new Set<string>();
  let grew = true;
  while (grew) {
    grew = false;
    for (const method of methods) {
      const statements = method.getStatements();
      const onlySetup =
        !only.has(method.getName()) &&
        statements.length > 0 &&
        statements.every((statement) => isSetup(statement, service, only));
      if (onlySetup) {
        only.add(method.getName());
        grew = true;
      }
    }
  }
  return only;
}

/** The module-level names each member of the chain is hoisted to. */
export function hoistedNames(
  service: ServiceModel,
  setupOnly: ReadonlySet<string>,
): Map<string, Hoisted> {
  const hoisted = new Map<string, Hoisted>();
  for (const cls of service.chain) {
    const file = cls.getSourceFile();
    const taken = new Set([
      ...file
        .getImportDeclarations()
        .flatMap((declaration) =>
          declaration
            .getNamedImports()
            .map((specifier) => (specifier.getAliasNode() ?? specifier.getNameNode()).getText()),
        ),
      ...file.getFunctions().map((fn) => fn.getName() ?? ""),
      ...file.getVariableDeclarations().map((variable) => variable.getName()),
      ...RESERVED,
    ]);
    const members = [
      ...cls
        .getMethods()
        .filter((method) => !setupOnly.has(method.getName()) && method.getBody() !== undefined),
      ...cls.getProperties().filter((property) => {
        const init = property.getInitializer();
        return (
          init !== undefined && (Node.isArrowFunction(init) || Node.isFunctionExpression(init))
        );
      }),
    ];
    for (const member of members) {
      const name = member.getName();
      if (hoisted.has(name)) {
        continue;
      }
      const moduleName = taken.has(name) ? `${name}Of${cls.getName() ?? "Service"}` : name;
      const publicMember = !member.hasModifier("private") && !member.hasModifier("protected");
      hoisted.set(name, {
        name: moduleName,
        file,
        exported: publicMember && !member.hasModifier("override"),
      });
    }
  }
  return hoisted;
}

/**
 * A member's leading comments (JSDoc included), moved to the start of the
 * line: their continuation lines lose the member's indentation.
 */
function leadingComments(node: Node): string[] {
  const indent =
    /[ \t]*$/u.exec(node.getSourceFile().getFullText().slice(0, node.getStart()))?.[0] ?? "";
  return node.getLeadingCommentRanges().map((range) =>
    range
      .getText()
      .split("\n")
      .map((line, index) =>
        index > 0 && line.startsWith(indent) ? line.slice(indent.length) : line,
      )
      .join("\n"),
  );
}

/** `node`'s text with its receiver references mapped and marked. */
/** Statements of a hoisted body that only set the 4.x service up: they vanish. */
function vanishing(body: Node, service: ServiceModel, setupOnly: ReadonlySet<string>): Set<Node> {
  const statements = Node.isBlock(body) ? body.getStatements() : [];
  return new Set(statements.filter((statement) => isSetup(statement, service, setupOnly)));
}

function mapped(
  node: Node,
  scope: ReceiverScope,
  imports: Hoisted[],
  removed: ReadonlySet<Node> = new Set(),
): { text: string; usesDb: boolean } {
  const result = mapReceiver(node, scope);
  const markers = new MarkerSet(node.getSourceFile());
  const text = node.getSourceFile().getFullText();
  for (const marker of result.markers) {
    if (!removed.has(statementOf(marker.node))) {
      markers.add(marker.node, marker.category, marker.message);
    }
  }
  imports.push(...result.imports);
  const removals = [...removed].map((statement) => {
    let start = statement.getStart();
    while (start > 0 && (text[start - 1] === " " || text[start - 1] === "\t")) {
      start -= 1;
    }
    return {
      start,
      end: text[statement.getEnd()] === "\n" ? statement.getEnd() + 1 : statement.getEnd(),
      text: "",
    };
  });
  const edits = [
    ...result.edits,
    ...removals,
    ...markers.edits.filter((edit) => edit.start > node.getStart()),
  ];
  return { text: editedText(node, edits), usesDb: result.usesDb };
}

function methodText(
  method: MethodDeclaration,
  target: Hoisted,
  scope: ReceiverScope,
  imports: Hoisted[],
  setupOnly: ReadonlySet<string>,
): { text: string; usesDb: boolean } {
  const body = method.getBody();
  const bodyText =
    body === undefined
      ? { text: "{}", usesDb: false }
      : mapped(body, scope, imports, vanishing(body, scope.service, setupOnly));
  const note =
    HOOK_NOTES[method.getName()] ??
    (method.hasModifier("override")
      ? {
          category: "this" as const,
          message: `overrode the 4.x BaseService method ${method.getName()}, which 5.0 does not have: keep what it still needs elsewhere, then delete it`,
        }
      : undefined);
  const params = method
    .getParameters()
    .map((param) => param.getText())
    .join(", ");
  const typeParams = method
    .getTypeParameters()
    .map((param) => param.getText())
    .join(", ");
  const returns = method.getReturnTypeNode()?.getText();
  const signature = [
    target.exported ? "export " : "",
    method.isAsync() ? "async " : "",
    `function ${target.name}`,
    typeParams === "" ? "" : `<${typeParams}>`,
    `(${params})`,
    returns === undefined ? "" : `: ${returns}`,
  ].join("");
  const lines = [
    ...leadingComments(method),
    ...(note === undefined ? [] : [markerText(note.category, note.message)]),
    `${signature} ${bodyText.text}`,
  ];
  return { text: lines.join("\n"), usesDb: bodyText.usesDb };
}

/** `defineCollection(name, options)` or `installAdminMethods(options)`, kept as a marked const. */
function setupConst(
  statement: Statement,
  name: "defineCollection" | "installAdminMethods",
  scope: ReceiverScope,
  imports: Hoisted[],
): { text: string; usesDb: boolean } {
  const call = Node.isExpressionStatement(statement) ? statement.getExpression() : undefined;
  const [first, second] =
    call !== undefined && Node.isCallExpression(call) ? call.getArguments() : [];
  const collection = name === "defineCollection";
  const options = collection ? second : first;
  const label = collection ? (first?.getText().replace(/["']/gu, "") ?? "collection") : "admin";
  const value =
    options === undefined ? { text: "{}", usesDb: false } : mapped(options, scope, imports);
  const note = collection
    ? markerText(
        "collection",
        `4.x collection "${label}": declare it in the contract's collections (scope, item, order) and anchor it in defineService's collections, then delete this; it is no longer used`,
      )
    : markerText(
        "admin",
        "installAdminMethods: use the admin kit (...admin.contract({ entity }) in the contract, ...admin.handlers(contract, { displayName, hiddenFields, fieldOverrides }) in methods), then delete this; it is no longer used",
      );
  const text = [
    ...leadingComments(statement),
    note,
    `const ${collection ? `${label}Collection` : "adminMethods"} = ${value.text};`,
  ].join("\n");
  return { text, usesDb: value.usesDb };
}

/** Whether a constructor statement vanishes: `super(...)`, a field assignment, or set-up. */
function vanishes(
  statement: Statement,
  service: ServiceModel,
  setupOnly: ReadonlySet<string>,
): boolean {
  const isSuper =
    Node.isExpressionStatement(statement) &&
    statement.getExpression().getText().startsWith("super(");
  return isSuper || isThisAssignment(statement) || isSetup(statement, service, setupOnly);
}

/** What a class's constructor still says, as module code. */
function constructorText(
  ctor: ConstructorDeclaration,
  service: ServiceModel,
  scope: ReceiverScope,
  setupOnly: ReadonlySet<string>,
  imports: Hoisted[],
): { texts: string[]; usesDb: boolean } {
  const texts: string[] = [];
  const leftovers: string[] = [];
  let usesDb = false;
  for (const statement of ctor.getStatements()) {
    if (vanishes(statement, service, setupOnly)) {
      continue;
    }
    const name = thisCallName(statement);
    const value =
      name === "defineCollection" || name === "installAdminMethods"
        ? setupConst(statement, name, scope, imports)
        : mapped(statement, scope, imports);
    usesDb ||= value.usesDb;
    (name === "defineCollection" || name === "installAdminMethods" ? texts : leftovers).push(
      value.text,
    );
  }
  if (leftovers.length > 0) {
    const setup = `setUp${service.className}`;
    texts.push(
      [
        markerText(
          "this",
          `4.x constructor code of ${service.className}: a service object has no constructor; move what still matters to module scope, a job or the server's start-up, then delete this function`,
        ),
        `function ${setup}(): void {`,
        ...leftovers,
        "}",
      ].join("\n"),
    );
  }
  return { texts, usesDb };
}

function isThisAssignment(statement: Statement): boolean {
  if (!Node.isExpressionStatement(statement)) {
    return false;
  }
  const expression = statement.getExpression();
  return (
    Node.isBinaryExpression(expression) &&
    expression.getOperatorToken().getText() === "=" &&
    /^this\.\w+$/u.test(expression.getLeft().getText())
  );
}

/** The module-level code that replaces `cls`, and whether it reads the tracked `db`. */
export function hoistClass(
  cls: ClassDeclaration,
  service: ServiceModel,
  hoisted: ReadonlyMap<string, Hoisted>,
  setupOnly: ReadonlySet<string>,
  imports: Hoisted[],
): { texts: string[]; usesDb: boolean } {
  const scope: ReceiverScope = {
    service,
    hoisted,
    receiver: "this",
    inHandler: false,
    ctxName: "ctx",
  };
  const texts: string[] = [];
  let usesDb = false;
  for (const member of cls.getMembers()) {
    if (Node.isConstructorDeclaration(member)) {
      const built = constructorText(member, service, scope, setupOnly, imports);
      texts.push(...built.texts);
      usesDb ||= built.usesDb;
    } else if (
      Node.isMethodDeclaration(member) &&
      hoisted.get(member.getName())?.file === cls.getSourceFile() &&
      member.getBody() !== undefined
    ) {
      const target = hoisted.get(member.getName());
      if (target !== undefined) {
        const built = methodText(member, target, scope, imports, setupOnly);
        texts.push(built.text);
        usesDb ||= built.usesDb;
      }
    } else if (Node.isPropertyDeclaration(member) && hoisted.has(member.getName())) {
      const init = member.getInitializer();
      const target = hoisted.get(member.getName());
      if (init !== undefined && target !== undefined) {
        const value = mapped(init, scope, imports);
        usesDb ||= value.usesDb;
        texts.push(
          [
            ...leadingComments(member),
            `${target.exported ? "export " : ""}const ${target.name} = ${value.text};`,
          ].join("\n"),
        );
      }
    }
  }
  return { texts, usesDb };
}
