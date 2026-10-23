// Recognizing database calls by shape. The tracked client is conventionally
// named `db` (the handler argument, or the app's `trackPrisma(...)` client in
// jobs), the client inside an interactive transaction `tx`, and the untracked
// Prisma client `prisma`. Rules take the names as options. A binding or class
// member this file declares with quickdraw's tracked client type
// (`prisma: Tracked<Db>`, `{ db }: { db: Tracked<Db> }`, `private prisma:
// Tracked<Db>`) is the tracked client whatever its name: the compiler refuses
// the untracked client there (`declaredTracked`). The type counts when the
// file imports it from quickdraw, under any name; an app's own type named
// `Tracked`, or one imported from anywhere else, says nothing about the client.

import { keyName, memberName, resolveVariable, unwrap } from "./ast.mjs";

/** Prisma model operations that write rows. */
export const WRITE_METHODS = new Set([
  "create",
  "createMany",
  "createManyAndReturn",
  "update",
  "updateMany",
  "updateManyAndReturn",
  "upsert",
  "delete",
  "deleteMany",
]);

/** Prisma model operations that read rows. */
export const READ_METHODS = new Set([
  "findUnique",
  "findUniqueOrThrow",
  "findFirst",
  "findFirstOrThrow",
  "findMany",
  "count",
  "aggregate",
  "groupBy",
]);

/** Every Prisma model operation. */
export const MODEL_METHODS = new Set([...WRITE_METHODS, ...READ_METHODS]);

/** The tracked client's names. */
export const TRACKED_CLIENTS = Object.freeze(["db", "tx"]);

/** Every client name, tracked or not. */
export const ALL_CLIENTS = Object.freeze(["db", "tx", "prisma"]);

/** The types that hold a client to the tracked one: `@fitzzero/quickdraw-core`'s `Tracked<C>` and `TrackedTransaction<C>`. */
export const TRACKED_TYPES = Object.freeze(["Tracked", "TrackedTransaction"]);

/** The modules `TRACKED_TYPES` come from: the root export and `./prisma`. */
export const TRACKED_MODULES = Object.freeze([
  "@fitzzero/quickdraw-core",
  "@fitzzero/quickdraw-core/prisma",
]);

/** The JSON Schema of a `clients` option. */
export const CLIENTS_OPTION = Object.freeze({
  type: "array",
  items: { type: "string" },
  description:
    "Names of the database client: an identifier, or a member ending in one (`this.db`).",
});

/** The client's name when `node` is one of `clients`: `db`, or a member ending in it (`this.prisma`). */
export function clientName(node, clients) {
  const receiver = unwrap(node);
  if (receiver.type === "Identifier" && clients.includes(receiver.name)) {
    return receiver.name;
  }
  if (receiver.type === "MemberExpression") {
    const name = memberName(receiver);
    if (name !== undefined && clients.includes(name)) {
      return name;
    }
  }
  return undefined;
}

/** How deep `isTrackedType` and `objectMembers` follow this file's type aliases (`type A = B; type B = A` ends). */
const ALIAS_DEPTH = 8;

/**
 * Whether the file imports `local` from `TRACKED_MODULES`: as `Tracked` or
 * `TrackedTransaction` (`import type { Tracked as T }` binds `T`), or, with
 * `namespace`, as a namespace (`import type * as quickdraw`). Imports are
 * module-level, so the program's own statements are all there is to read.
 */
function importsTracked(context, local, namespace) {
  return context.sourceCode.ast.body.some(
    (statement) =>
      statement.type === "ImportDeclaration" &&
      TRACKED_MODULES.includes(statement.source.value) &&
      statement.specifiers.some((specifier) =>
        namespace
          ? specifier.type === "ImportNamespaceSpecifier" && specifier.local.name === local
          : specifier.type === "ImportSpecifier" &&
            specifier.local.name === local &&
            TRACKED_TYPES.includes(specifier.imported.name ?? specifier.imported.value),
      ),
  );
}

/** The type alias or interface of this file's top level that `type` names, when neither has type parameters. */
function localType(context, type) {
  if (
    type?.type !== "TSTypeReference" ||
    type.typeName.type !== "Identifier" ||
    (type.typeArguments ?? type.typeParameters ?? null) !== null
  ) {
    return undefined;
  }
  for (const statement of context.sourceCode.ast.body) {
    const declaration =
      statement.type === "ExportNamedDeclaration" ? statement.declaration : statement;
    if (
      (declaration?.type === "TSTypeAliasDeclaration" ||
        declaration?.type === "TSInterfaceDeclaration") &&
      declaration.id.name === type.typeName.name
    ) {
      return (declaration.typeParameters ?? null) === null ? declaration : undefined;
    }
  }
  return undefined;
}

/** Whether a type reference's name is quickdraw's `Tracked` or `TrackedTransaction`, as this file imports it. */
function isTrackedReference(context, name) {
  if (name.type === "Identifier") {
    return importsTracked(context, name.name, false);
  }
  return (
    name.type === "TSQualifiedName" &&
    name.left.type === "Identifier" &&
    TRACKED_TYPES.includes(name.right.name) &&
    importsTracked(context, name.left.name, true)
  );
}

/**
 * Whether a type says the tracked client, by its text (the rule cannot see
 * types): quickdraw's `Tracked<...>` or `TrackedTransaction<...>`, imported
 * from `TRACKED_MODULES` under any name or through a namespace, this file's
 * type alias of one, a union of only those, or an intersection with one.
 */
export function isTrackedType(context, type, depth = 0) {
  switch (type?.type) {
    case "TSTypeReference": {
      if (isTrackedReference(context, type.typeName)) {
        return true;
      }
      const declaration = depth < ALIAS_DEPTH ? localType(context, type) : undefined;
      return (
        declaration?.type === "TSTypeAliasDeclaration" &&
        isTrackedType(context, declaration.typeAnnotation, depth + 1)
      );
    }
    case "TSUnionType":
      return type.types.every((member) => isTrackedType(context, member, depth));
    case "TSIntersectionType":
      return type.types.some((member) => isTrackedType(context, member, depth));
    default:
      return false;
  }
}

/** The members of an object type: a type literal, an intersection of them, or this file's interface or type alias of one. */
function objectMembers(context, type, depth = 0) {
  switch (type?.type) {
    case "TSTypeLiteral":
      return type.members;
    case "TSIntersectionType":
      return type.types.flatMap((part) => objectMembers(context, part, depth) ?? []);
    case "TSTypeReference": {
      const declaration = depth < ALIAS_DEPTH ? localType(context, type) : undefined;
      if (declaration?.type === "TSInterfaceDeclaration") {
        return declaration.body.body;
      }
      return declaration?.type === "TSTypeAliasDeclaration"
        ? objectMembers(context, declaration.typeAnnotation, depth + 1)
        : undefined;
    }
    default:
      return undefined;
  }
}

/** The type at `path` inside an object type: `{ deps: { db: Tracked<Db> } }` at `["deps", "db"]` is `Tracked<Db>`. */
function memberType(context, type, path) {
  let current = type;
  for (const key of path) {
    const member = objectMembers(context, current)?.find(
      (candidate) =>
        candidate.type === "TSPropertySignature" &&
        !candidate.computed &&
        keyName(candidate) === key,
    );
    current = member?.typeAnnotation?.typeAnnotation;
    if (current === undefined) {
      return undefined;
    }
  }
  return current;
}

/**
 * The type a binding is declared with: its own annotation (`prisma:
 * Tracked<Db>`), or its part of an annotated destructuring pattern's type
 * (`{ db }: { db: Tracked<Db> }`, nested and with defaults too).
 */
function bindingType(context, identifier) {
  if (identifier?.typeAnnotation !== undefined && identifier.typeAnnotation !== null) {
    return identifier.typeAnnotation.typeAnnotation;
  }
  const path = [];
  let node = identifier;
  for (let parent = node?.parent; parent !== null && parent !== undefined; parent = node.parent) {
    if (parent.type === "AssignmentPattern" && parent.left === node) {
      node = parent;
      continue;
    }
    const property =
      parent.type === "Property" &&
      parent.parent?.type === "ObjectPattern" &&
      (parent.value === node || (parent.shorthand === true && parent.key === node));
    const key = property ? keyName(parent) : undefined;
    if (key === undefined) {
      return undefined;
    }
    path.unshift(key);
    node = parent.parent;
    if (node.typeAnnotation !== undefined && node.typeAnnotation !== null) {
      return memberType(context, node.typeAnnotation.typeAnnotation, path);
    }
  }
  return undefined;
}

/** A class member's name as `this.<name>` reads it: `prisma`, or `#prisma` for a private one. */
function classKeyName(key) {
  if (key.type === "PrivateIdentifier") {
    return `#${key.name}`;
  }
  if (key.type === "Identifier") {
    return key.name;
  }
  return key.type === "Literal" && typeof key.value === "string" ? key.value : undefined;
}

/** The type a class body declares its member `name` with: a property, or a constructor's parameter property. */
function classMemberType(body, name, isStatic) {
  for (const member of body.body) {
    if (
      (member.type === "PropertyDefinition" || member.type === "TSAbstractPropertyDefinition") &&
      !member.computed &&
      (member.static === true) === isStatic &&
      classKeyName(member.key) === name
    ) {
      return member.typeAnnotation?.typeAnnotation;
    }
    if (!isStatic && member.type === "MethodDefinition" && member.kind === "constructor") {
      for (const param of member.value.params) {
        const binding =
          param.type === "TSParameterProperty"
            ? param.parameter.type === "AssignmentPattern"
              ? param.parameter.left
              : param.parameter
            : undefined;
        if (binding?.type === "Identifier" && binding.name === name) {
          return binding.typeAnnotation?.typeAnnotation;
        }
      }
    }
  }
  return undefined;
}

/**
 * The type the class whose `this` a member expression reads declares the
 * member with (`this.prisma` and `private readonly prisma: Tracked<Db>`, or
 * `constructor(private prisma: Tracked<Db>)`). `this` in a function that is
 * not a method is not the class's, and a member a base class declares is not
 * read.
 */
function thisMemberType(member) {
  if (member.object.type !== "ThisExpression" || member.computed) {
    return undefined;
  }
  const name = classKeyName(member.property);
  let isStatic = false;
  for (let node = member.parent; node !== null && node !== undefined; node = node.parent) {
    switch (node.type) {
      case "FunctionExpression":
      case "FunctionDeclaration":
        if (node.parent?.type !== "MethodDefinition") {
          return undefined;
        }
        break;
      case "MethodDefinition":
      case "PropertyDefinition":
        isStatic = node.static === true;
        break;
      case "StaticBlock":
        isStatic = true;
        break;
      case "ClassBody":
        return name === undefined ? undefined : classMemberType(node, name, isStatic);
      default:
        break;
    }
  }
  return undefined;
}

/**
 * Whether `node` names a binding or a class member this file declares with a
 * tracked client's type (`prisma: Tracked<Db>`, `const client:
 * TrackedTransaction<Db> = tx`, `{ db }: { db: Tracked<Db> }`, `this.prisma`
 * with `private readonly prisma: Tracked<Db>`): the compiler holds it to the
 * tracked client, whatever it is named. A name declared in another file, and
 * a member a base class declares, are not read.
 */
export function declaredTracked(context, node) {
  const receiver = unwrap(node);
  if (receiver?.type === "MemberExpression") {
    return isTrackedType(context, thisMemberType(receiver));
  }
  if (receiver?.type !== "Identifier") {
    return false;
  }
  const definitions = resolveVariable(context, receiver)?.defs ?? [];
  return (
    definitions.length > 0 &&
    definitions.every((definition) => isTrackedType(context, bindingType(context, definition.name)))
  );
}

/** The name a client receiver goes by: `prisma`, `this.prisma`'s `prisma`, `this.#db`'s `#db`. */
function receiverName(receiver) {
  if (receiver.type === "Identifier") {
    return receiver.name;
  }
  if (receiver.type !== "MemberExpression") {
    return undefined;
  }
  return receiver.property.type === "PrivateIdentifier" && !receiver.computed
    ? `#${receiver.property.name}`
    : memberName(receiver);
}

/**
 * A model operation on one of `clients`: `db.task.update(...)` gives
 * `{ client: "db", model: "task", method: "update", args, receiver }`, the
 * receiver being the client's node. A computed model (`db[name]`) and the
 * client's own `$` methods are not model calls. Given the rule's `context`,
 * a receiver declared with a tracked client's type counts as one of
 * `clients` whatever its name (`declaredTracked`).
 */
export function modelCall(node, clients, context) {
  const call = unwrap(node);
  if (call?.type !== "CallExpression") {
    return undefined;
  }
  const callee = unwrap(call.callee);
  if (callee.type !== "MemberExpression") {
    return undefined;
  }
  const method = memberName(callee);
  if (method === undefined || !MODEL_METHODS.has(method)) {
    return undefined;
  }
  const delegate = unwrap(callee.object);
  if (delegate.type !== "MemberExpression" || delegate.computed) {
    return undefined;
  }
  const model = memberName(delegate);
  if (model === undefined || model.startsWith("$")) {
    return undefined;
  }
  const receiver = unwrap(delegate.object);
  const client =
    clientName(receiver, clients) ??
    (context !== undefined && declaredTracked(context, receiver)
      ? receiverName(receiver)
      : undefined);
  if (client === undefined) {
    return undefined;
  }
  return { call, client, model, method, args: call.arguments, receiver };
}
