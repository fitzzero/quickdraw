// What `docs/protocol-v5.md` is generated from (`quickdraw-protocol`), read
// with the TypeScript parser rather than imported: the frame types and their
// doc comments in `protocol/envelope.ts` (normative, RFC 0003 section 8), the
// handshake in `protocol/version.ts`, the error codes in `protocol/errors.ts`,
// the event, room and topic names in `contract/names.ts`, and the limits and
// defaults a server announces or applies (the dispatcher's, the socket rate
// limiter's, `qd:col:items`', the channels' and the stream feeds'). The
// document says what the source text says,
// so `--check` fails on any change to it. This module turns declarations
// into fields and shapes; `protocolModel.ts` assembles the document's model.

import { readFileSync } from "node:fs";
import { join } from "node:path";
import ts from "typescript";

/** The source files, relative to the core package. */
export const PROTOCOL_SOURCES = Object.freeze({
  envelope: "src/protocol/envelope.ts",
  version: "src/protocol/version.ts",
  errors: "src/protocol/errors.ts",
  names: "src/contract/names.ts",
  access: "src/contract/access.ts",
  settings: "src/server/pipeline/settings.ts",
  rateLimit: "src/server/rateLimit.ts",
  middleware: "src/server/transports/middleware.ts",
  backoff: "src/client/backoff.ts",
  items: "src/server/collections/items.ts",
  realtime: "src/contract/realtime.ts",
  channels: "src/server/realtime/channels.ts",
  streams: "src/server/realtime/streamSubscriptions.ts",
});

export type SourceName = keyof typeof PROTOCOL_SOURCES;

/** The parsed source files. */
export type Sources = Readonly<Record<SourceName, ts.SourceFile>>;

/** One field of a frame: a property of an object type, or an element of a tuple. */
export interface Field {
  readonly name: string;
  readonly optional: boolean;
  readonly type: string;
  readonly doc: string;
}

/** A type as the document shows it. */
export type Shape =
  | { readonly kind: "fields"; readonly fields: readonly Field[] }
  | { readonly kind: "tuple"; readonly fields: readonly Field[] }
  | { readonly kind: "union"; readonly members: readonly Shape[] }
  | { readonly kind: "text"; readonly text: string };

/** An exported interface or type alias. */
export interface TypeDoc {
  readonly name: string;
  readonly source: SourceName;
  /** The title of the banner comment (`// Calls (section 8.2)` between dashed lines) above it, if any. */
  readonly group: string | undefined;
  readonly doc: string;
  readonly shape: Shape;
}

/** Reads and parses the source files of the core package at `packageDir`. */
export function readSources(packageDir: string): Sources {
  const entries = Object.entries(PROTOCOL_SOURCES).map(([name, path]) => {
    const text = readFileSync(join(packageDir, path), "utf8");
    return [name, ts.createSourceFile(path, text, ts.ScriptTarget.ES2022, true)] as const;
  });
  return Object.fromEntries(entries) as Sources;
}

/** A node's doc comment, with `{@link X}` written as `` `X` ``. */
export function docOf(node: ts.Node): string {
  const docs = ts.getJSDocCommentsAndTags(node).filter((doc) => ts.isJSDoc(doc));
  const comment = docs.at(-1)?.comment;
  const text = comment === undefined ? "" : (ts.getTextOfJSDocComment(comment) ?? "");
  return text.replace(/\{@link\s+([^\s|}]+)[^}]*\}/g, "`$1`").trim();
}

function printReference(node: ts.TypeReferenceNode): string {
  const name = node.typeName.getText();
  const args = node.typeArguments ?? [];
  const [only] = args;
  if (name === "Readonly" && only !== undefined && args.length === 1) {
    return printType(only);
  }
  return args.length === 0 ? name : `${name}<${args.map(printType).join(", ")}>`;
}

/** The type as written, on one line, without `readonly` and `Readonly<>`. */
export function printType(node: ts.TypeNode): string {
  if (ts.isTypeOperatorNode(node) && node.operator === ts.SyntaxKind.ReadonlyKeyword) {
    return printType(node.type);
  }
  if (ts.isTypeReferenceNode(node)) {
    return printReference(node);
  }
  if (ts.isArrayTypeNode(node)) {
    return `${printType(node.elementType)}[]`;
  }
  if (ts.isParenthesizedTypeNode(node)) {
    return `(${printType(node.type)})`;
  }
  if (ts.isUnionTypeNode(node)) {
    return node.types.map(printType).join(" | ");
  }
  if (ts.isTypeLiteralNode(node)) {
    const fields = fieldsOf(node.members).map(
      (field) => `${field.name}${field.optional ? "?" : ""}: ${field.type}`,
    );
    return `{ ${fields.join("; ")} }`;
  }
  if (ts.isTupleTypeNode(node)) {
    return `[${tupleFields(node)
      .map((field) => `${field.name}: ${field.type}`)
      .join(", ")}]`;
  }
  return node.getText().replace(/\s+/g, " ");
}

/** The properties of an object type, but those typed `undefined`: they are never sent. */
function fieldsOf(members: ts.NodeArray<ts.TypeElement>): Field[] {
  return members.filter(ts.isPropertySignature).flatMap((member) => {
    const type = member.type === undefined ? "unknown" : printType(member.type);
    if (type === "undefined") {
      return [];
    }
    const optional = member.questionToken !== undefined;
    return [{ name: member.name.getText(), optional, type, doc: docOf(member) }];
  });
}

function tupleFields(node: ts.TupleTypeNode): Field[] {
  return node.elements.map((element, index) => {
    if (!ts.isNamedTupleMember(element)) {
      return { name: String(index), optional: false, type: printType(element), doc: "" };
    }
    const rest = element.dotDotDotToken === undefined ? "" : "...";
    return {
      name: `${rest}${element.name.text}`,
      optional: element.questionToken !== undefined,
      type: printType(element.type),
      doc: docOf(element),
    };
  });
}

function isNamed(member: ts.TypeNode): boolean {
  return ts.isTypeLiteralNode(member) || ts.isTypeReferenceNode(member);
}

/** How a type alias is shown: fields, a tuple's elements, the members of a union of shapes, or text. */
function shapeOf(node: ts.TypeNode): Shape {
  if (ts.isTypeOperatorNode(node) && node.operator === ts.SyntaxKind.ReadonlyKeyword) {
    return shapeOf(node.type);
  }
  if (ts.isTypeLiteralNode(node)) {
    return { kind: "fields", fields: fieldsOf(node.members) };
  }
  if (ts.isTupleTypeNode(node)) {
    return { kind: "tuple", fields: tupleFields(node) };
  }
  if (ts.isUnionTypeNode(node) && node.types.some(isNamed)) {
    const members = node.types.map(
      (member): Shape =>
        ts.isTypeLiteralNode(member) ? shapeOf(member) : { kind: "text", text: printType(member) },
    );
    return { kind: "union", members };
  }
  return { kind: "text", text: printType(node) };
}

function isExported(node: ts.Statement): boolean {
  return ts.canHaveModifiers(node)
    ? (ts.getModifiers(node) ?? []).some(
        (modifier) => modifier.kind === ts.SyntaxKind.ExportKeyword,
      )
    : false;
}

/** The interfaces of every source, exported or not, by name. */
export function interfacesOf(sources: Sources): ReadonlyMap<string, ts.InterfaceDeclaration> {
  const found = new Map<string, ts.InterfaceDeclaration>();
  for (const file of Object.values(sources)) {
    for (const statement of file.statements) {
      if (ts.isInterfaceDeclaration(statement)) {
        found.set(statement.name.text, statement);
      }
    }
  }
  return found;
}

/** An interface's fields, its bases' first (`CollectionSubscribe extends CollectionScopeRef`). */
function interfaceFields(
  node: ts.InterfaceDeclaration,
  interfaces: ReadonlyMap<string, ts.InterfaceDeclaration>,
): Field[] {
  const bases = (node.heritageClauses ?? []).flatMap((clause) =>
    clause.types.map((base) => base.expression.getText()),
  );
  const inherited = bases.flatMap((name) => {
    const base = interfaces.get(name);
    if (base === undefined) {
      throw new Error(`${node.name.text} extends ${name}, which no protocol source declares`);
    }
    return interfaceFields(base, interfaces);
  });
  return [...inherited, ...fieldsOf(node.members)];
}

function typeDocOf(
  statement: ts.Statement,
  where: Pick<TypeDoc, "source" | "group">,
  interfaces: ReadonlyMap<string, ts.InterfaceDeclaration>,
): TypeDoc | undefined {
  if (ts.isInterfaceDeclaration(statement)) {
    const fields = interfaceFields(statement, interfaces);
    const shape: Shape = { kind: "fields", fields };
    return { name: statement.name.text, ...where, doc: docOf(statement), shape };
  }
  // The event maps are mapped types over the listener interfaces; the events are documented instead.
  if (ts.isTypeAliasDeclaration(statement) && !ts.isMappedTypeNode(statement.type)) {
    const shape = shapeOf(statement.type);
    return { name: statement.name.text, ...where, doc: docOf(statement), shape };
  }
  return undefined;
}

const DASHES = /^\/\/ -{10,}$/;

/**
 * The title of a banner comment just above `statement`, without its
 * parenthetical: `// Calls (section 8.2)` between two dashed lines is `Calls`.
 */
function bannerOf(statement: ts.Statement, file: ts.SourceFile): string | undefined {
  const lines = (ts.getLeadingCommentRanges(file.text, statement.pos) ?? []).map((range) =>
    file.text.slice(range.pos, range.end),
  );
  const at = lines.findIndex(
    (line, index) =>
      DASHES.test(line) && index + 2 < lines.length && DASHES.test(lines[index + 2] ?? ""),
  );
  const title = at === -1 ? undefined : lines[at + 1]?.replace(/^\/\/\s*/, "");
  return title?.replace(/\s*\(.*\)$/, "");
}

/** The exported interfaces and type aliases of `from`, by name, in source order. */
export function typesOf(sources: Sources, from: readonly SourceName[]): Map<string, TypeDoc> {
  const interfaces = interfacesOf(sources);
  const types = new Map<string, TypeDoc>();
  for (const source of from) {
    let group: string | undefined;
    for (const statement of sources[source].statements) {
      group = bannerOf(statement, sources[source]) ?? group;
      const type = isExported(statement)
        ? typeDocOf(statement, { source, group }, interfaces)
        : undefined;
      if (type !== undefined) {
        types.set(type.name, type);
      }
    }
  }
  return types;
}

/** An expression without `Object.freeze(...)`, `as const` and parentheses around it. */
export function unwrap(expression: ts.Expression): ts.Expression {
  if (ts.isAsExpression(expression) || ts.isParenthesizedExpression(expression)) {
    return unwrap(expression.expression);
  }
  if (ts.isCallExpression(expression) && expression.expression.getText() === "Object.freeze") {
    const [argument] = expression.arguments;
    return argument === undefined ? expression : unwrap(argument);
  }
  return expression;
}

/** The variable statement declaring `name` in `file`, and its unwrapped initializer. */
export function variableOf(
  file: ts.SourceFile,
  name: string,
): { readonly statement: ts.VariableStatement; readonly value: ts.Expression } {
  for (const statement of file.statements) {
    if (!ts.isVariableStatement(statement)) {
      continue;
    }
    for (const declaration of statement.declarationList.declarations) {
      if (ts.isIdentifier(declaration.name) && declaration.name.text === name) {
        if (declaration.initializer !== undefined) {
          return { statement, value: unwrap(declaration.initializer) };
        }
      }
    }
  }
  throw new Error(`quickdraw-protocol: ${file.fileName} declares no ${name}, which it documents`);
}

/** A literal as the document writes it: a number without separators, a string quoted, a list joined. */
export function literalText(expression: ts.Expression): string | undefined {
  if (ts.isNumericLiteral(expression)) {
    return expression.text;
  }
  if (ts.isStringLiteral(expression) || ts.isNoSubstitutionTemplateLiteral(expression)) {
    return JSON.stringify(expression.text);
  }
  if (ts.isArrayLiteralExpression(expression)) {
    const items = expression.elements.map((element) => literalText(unwrap(element)));
    return items.every((item) => item !== undefined) ? items.join(", ") : undefined;
  }
  return undefined;
}

/** The properties of an object literal: name, unwrapped initializer and doc comment. */
export function propertiesOf(
  expression: ts.Expression,
  what: string,
): { readonly name: string; readonly value: ts.Expression; readonly doc: string }[] {
  if (!ts.isObjectLiteralExpression(expression)) {
    throw new Error(`quickdraw-protocol: ${what} is not an object literal`);
  }
  return expression.properties.filter(ts.isPropertyAssignment).map((property) => ({
    name: property.name.getText(),
    value: unwrap(property.initializer),
    doc: docOf(property),
  }));
}
