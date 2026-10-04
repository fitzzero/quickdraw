// What happens to the rest of a 4.x service class. A service object has no
// members, so each member becomes module-level code in the class's file:
// helper methods and getters become functions (exported when they were
// public, since other files may call them), fields become module bindings
// under a marker (a field's initializer kept; a field its constructor set is
// set by the setup function), overridden 4.x hooks become functions under a
// marker, `defineCollection` and `installAdminMethods` options become consts
// under a marker, and any other constructor code, its field assignments
// included, goes into a marked, exported setup function that takes the
// constructor's parameters it uses. Nothing the codemod cannot translate is
// deleted. Only the Prisma client's field goes (it is the tracked `db`), and a
// field holding another 4.x service, whose uses are marked: services call
// each other through `ctx.services`.

import {
  type ClassDeclaration,
  type ConstructorDeclaration,
  type GetAccessorDeclaration,
  type MethodDeclaration,
  Node,
  type ParameterDeclaration,
  type PropertyDeclaration,
  type SetAccessorDeclaration,
  type Statement,
  SyntaxKind,
} from "ts-morph";
import {
  assignedMember,
  isFunctionProperty,
  keptFields,
  localNames,
  reassigned,
  setByConstructor,
} from "./fields";
import { HOOK_NOTES } from "./hookNotes";
import { type Category, MarkerSet, markerAnchor, markerText } from "./markers";
import type { ServiceModel } from "./model";
import { type Hoisted, mapReceiver, type ReceiverScope } from "./receiver";
import { editedText, statementOf, upperFirst } from "./text";

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
  const locals = localNames(service);
  for (const cls of service.chain) {
    const file = cls.getSourceFile();
    const taken = new Set([
      ...locals,
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
    const members: (MethodDeclaration | PropertyDeclaration | GetAccessorDeclaration)[] = [
      ...cls
        .getMethods()
        .filter((method) => !setupOnly.has(method.getName()) && method.getBody() !== undefined),
      ...cls.getProperties().filter(isFunctionProperty),
      ...keptFields(cls, service),
      ...cls.getGetAccessors().filter((getter) => getter.getBody() !== undefined),
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
        ...(Node.isGetAccessorDeclaration(member) ? { getter: true } : {}),
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

/** Statements of a hoisted body that only set the 4.x service up: they vanish. */
function vanishing(body: Node, service: ServiceModel, setupOnly: ReadonlySet<string>): Set<Node> {
  const statements = Node.isBlock(body) ? body.getStatements() : [];
  return new Set(statements.filter((statement) => isSetup(statement, service, setupOnly)));
}

/** Hoisted code: its text, whether it reads the tracked `db`, and the markers to put above it. */
interface Mapped {
  readonly text: string;
  readonly usesDb: boolean;
  /** Markers about `node` itself, or about a line it starts: they go above the code that holds it. */
  readonly outer: readonly string[];
}

/**
 * `node`'s text with its receiver references mapped and marked. A marker
 * that belongs above `node` itself (or above a line `node` starts) cannot go
 * inside its text: it is returned in `outer`, for the caller to put above
 * the code it writes.
 */
function mapped(
  node: Node,
  scope: ReceiverScope,
  imports: Hoisted[],
  removed: ReadonlySet<Node> = new Set(),
): Mapped {
  const result = mapReceiver(node, scope);
  const markers = new MarkerSet(node.getSourceFile());
  const text = node.getSourceFile().getFullText();
  const outer: string[] = [];
  for (const marker of result.markers) {
    const target = statementOf(marker.node);
    if (removed.has(target)) {
      continue;
    }
    if (markerAnchor(target).getStart() > node.getStart()) {
      markers.addAbove(target, marker.category, marker.message);
    } else {
      const line = markerText(marker.category, marker.message);
      if (!outer.includes(line)) {
        outer.push(line);
      }
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
  const edits = [...result.edits, ...removals, ...markers.edits];
  return { text: editedText(node, edits), usesDb: result.usesDb, outer };
}

/** The function a method, a getter or a setter is hoisted into, with its markers. */
function functionText(
  member: MethodDeclaration | GetAccessorDeclaration | SetAccessorDeclaration,
  name: string,
  exported: boolean,
  notes: readonly { category: Category; message: string }[],
  scope: ReceiverScope,
  imports: Hoisted[],
  setupOnly: ReadonlySet<string>,
): { text: string; usesDb: boolean } {
  const body = member.getBody();
  const bodyText =
    body === undefined
      ? { text: "{}", usesDb: false, outer: [] }
      : mapped(body, scope, imports, vanishing(body, scope.service, setupOnly));
  const params = member
    .getParameters()
    .map((param) => param.getText())
    .join(", ");
  const typeParams = member
    .getTypeParameters()
    .map((param) => param.getText())
    .join(", ");
  const returns = member.getReturnTypeNode()?.getText();
  const signature = [
    exported ? "export " : "",
    Node.isMethodDeclaration(member) && member.isAsync() ? "async " : "",
    `function ${name}`,
    typeParams === "" ? "" : `<${typeParams}>`,
    `(${params})`,
    returns === undefined ? "" : `: ${returns}`,
  ].join("");
  const lines = [
    ...leadingComments(member),
    ...notes.map((note) => markerText(note.category, note.message)),
    ...bodyText.outer,
    `${signature} ${bodyText.text}`,
  ];
  return { text: lines.join("\n"), usesDb: bodyText.usesDb };
}

function methodText(
  method: MethodDeclaration,
  target: Hoisted,
  scope: ReceiverScope,
  imports: Hoisted[],
  setupOnly: ReadonlySet<string>,
): { text: string; usesDb: boolean } {
  const note =
    HOOK_NOTES[method.getName()] ??
    (method.hasModifier("override")
      ? {
          category: "this" as const,
          message: `overrode the 4.x BaseService method ${method.getName()}, which 5.0 does not have: keep what it still needs elsewhere, then delete it`,
        }
      : undefined);
  return functionText(
    method,
    target.name,
    target.exported,
    note === undefined ? [] : [note],
    scope,
    imports,
    setupOnly,
  );
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
    options === undefined
      ? { text: "{}", usesDb: false, outer: [] }
      : mapped(options, scope, imports);
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
    ...value.outer,
    `const ${collection ? `${label}Collection` : "adminMethods"} = ${value.text};`,
  ].join("\n");
  return { text, usesDb: value.usesDb };
}

/**
 * Whether a constructor statement vanishes: `super(...)`, set-up, or an
 * assignment of a field that is not kept (the Prisma client, which is `db`
 * now; a field holding another 4.x service, whose uses are marked).
 */
function vanishes(
  statement: Statement,
  scope: ReceiverScope,
  setupOnly: ReadonlySet<string>,
): boolean {
  const isSuper =
    Node.isExpressionStatement(statement) &&
    statement.getExpression().getText().startsWith("super(");
  const field = assignedMember(statement);
  return (
    isSuper ||
    (field !== undefined && scope.hoisted.get(field)?.getter !== undefined) ||
    (field !== undefined && !scope.hoisted.has(field)) ||
    isSetup(statement, scope.service, setupOnly)
  );
}

/** A parameter as a function's parameter: a parameter property loses its modifiers. */
function parameterText(param: ParameterDeclaration): string {
  const type = param.getTypeNode()?.getText();
  const init = param.getInitializer()?.getText();
  return [
    param.isRestParameter() ? "..." : "",
    param.getNameNode().getText(),
    param.hasQuestionToken() ? "?" : "",
    type === undefined ? "" : `: ${type}`,
    init === undefined ? "" : ` = ${init}`,
  ].join("");
}

/** The name of the setup function a class's leftover constructor code goes into. */
export function setupName(service: ServiceModel): string {
  return `setUp${service.className}`;
}

/** What a class's constructor still says, as module code. */
function constructorText(
  ctor: ConstructorDeclaration,
  scope: ReceiverScope,
  setupOnly: ReadonlySet<string>,
  imports: Hoisted[],
): { texts: string[]; usesDb: boolean } {
  const { service } = scope;
  const texts: string[] = [];
  const leftovers: Statement[] = [];
  const leftoverTexts: string[] = [];
  let usesDb = false;
  for (const statement of ctor.getStatements()) {
    if (vanishes(statement, scope, setupOnly)) {
      continue;
    }
    const name = thisCallName(statement);
    if (name === "defineCollection" || name === "installAdminMethods") {
      const value = setupConst(statement, name, scope, imports);
      usesDb ||= value.usesDb;
      texts.push(value.text);
      continue;
    }
    const value = mapped(statement, scope, imports);
    usesDb ||= value.usesDb;
    leftovers.push(statement);
    leftoverTexts.push([...value.outer, value.text].join("\n"));
  }
  if (leftovers.length > 0) {
    // the setup function takes the constructor's parameters its code uses
    const used = (param: ParameterDeclaration): boolean => {
      const symbol = param.getSymbol();
      return leftovers.some((statement) =>
        statement
          .getDescendantsOfKind(SyntaxKind.Identifier)
          .some((identifier) => identifier.getSymbol() === symbol),
      );
    };
    const params = ctor.getParameters().filter(used).map(parameterText).join(", ");
    texts.push(
      [
        markerText(
          "this",
          `4.x constructor code of ${service.className}, its fields' values included: a service object has no constructor; call ${setupName(service)}(...) once where the server starts (or move each part to module scope or a job), then delete this function`,
        ),
        `export function ${setupName(service)}(${params}): void {`,
        ...leftoverTexts,
        "}",
      ].join("\n"),
    );
  }
  return { texts, usesDb };
}

/** A field as a module binding, under a marker: `const` when nothing writes it after its initializer. */
function fieldText(
  field: PropertyDeclaration,
  target: Hoisted,
  scope: ReceiverScope,
  imports: Hoisted[],
): { text: string; usesDb: boolean } {
  const { service } = scope;
  const name = field.getName();
  const init = field.getInitializer();
  const value = init === undefined ? undefined : mapped(init, scope, imports);
  const type = field.getTypeNode()?.getText();
  const fixed = value !== undefined && (field.isReadonly() || !reassigned(service, name));
  const where =
    value === undefined && setByConstructor(service, name)
      ? `, set by its constructor: now a module binding ${setupName(service)}(...) sets`
      : ": now module state";
  const note = markerText(
    "this",
    `4.x instance field ${name} of ${service.className}${where}, one value for the whole process (a service object has no instance); keep it if that is right, else move it where it belongs`,
  );
  const declaration = [
    target.exported ? "export " : "",
    fixed ? "const " : "let ",
    target.name,
    type === undefined ? "" : `: ${type}`,
    value === undefined ? "" : ` = ${value.text}`,
    ";",
  ].join("");
  return {
    text: [...leadingComments(field), note, ...(value?.outer ?? []), declaration].join("\n"),
    usesDb: value?.usesDb ?? false,
  };
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
  const own = (name: string): Hoisted | undefined => {
    const target = hoisted.get(name);
    return target?.file === cls.getSourceFile() ? target : undefined;
  };
  const add = (built: { text: string; usesDb: boolean }): void => {
    texts.push(built.text);
    usesDb ||= built.usesDb;
  };
  for (const member of cls.getMembers()) {
    if (Node.isConstructorDeclaration(member)) {
      const built = constructorText(member, scope, setupOnly, imports);
      texts.push(...built.texts);
      usesDb ||= built.usesDb;
    } else if (Node.isMethodDeclaration(member) && member.getBody() !== undefined) {
      const target = own(member.getName());
      if (target !== undefined) {
        add(methodText(member, target, scope, imports, setupOnly));
      }
    } else if (Node.isGetAccessorDeclaration(member)) {
      const target = own(member.getName());
      if (target !== undefined) {
        add(functionText(member, target.name, target.exported, [], scope, imports, setupOnly));
      }
    } else if (Node.isSetAccessorDeclaration(member) && member.getBody() !== undefined) {
      const name = `set${upperFirst(member.getName())}`;
      const note = {
        category: "this" as const,
        message: `4.x setter ${member.getName()} of ${service.className}, now the function ${name}: where code assigned this.${member.getName()}, call it`,
      };
      add(functionText(member, name, false, [note], scope, imports, setupOnly));
    } else if (Node.isPropertyDeclaration(member) && own(member.getName()) !== undefined) {
      const target = own(member.getName());
      const init = member.getInitializer();
      if (target === undefined) {
        continue;
      }
      if (init !== undefined && (Node.isArrowFunction(init) || Node.isFunctionExpression(init))) {
        const value = mapped(init, scope, imports);
        add({
          text: [
            ...leadingComments(member),
            ...value.outer,
            `${target.exported ? "export " : ""}const ${target.name} = ${value.text};`,
          ].join("\n"),
          usesDb: value.usesDb,
        });
      } else {
        add(fieldText(member, target, scope, imports));
      }
    }
  }
  return { texts, usesDb };
}
