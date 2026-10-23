// Recognizing database calls by shape. The tracked client is conventionally
// named `db` (the handler argument, or the app's `trackPrisma(...)` client in
// jobs), the client inside an interactive transaction `tx`, and the untracked
// Prisma client `prisma`. Rules take the names as options. A parameter or
// variable this file declares with a tracked client's type
// (`prisma: Tracked<Db>`) is the tracked client whatever its name: the
// compiler refuses the untracked client there (`declaredTracked`).

import { memberName, resolveVariable, unwrap } from "./ast.mjs";

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

/** The name a type reference ends in: `Tracked` for `Tracked<Db>` and for `quickdraw.Tracked<Db>`. */
function referenceName(name) {
  if (name.type === "Identifier") {
    return name.name;
  }
  return name.type === "TSQualifiedName" ? referenceName(name.right) : undefined;
}

/**
 * Whether a type says the tracked client, by its text (the rule cannot see
 * types): `Tracked<...>` or `TrackedTransaction<...>`, qualified or not, a
 * union of only those, or an intersection with one.
 */
export function isTrackedType(type) {
  switch (type?.type) {
    case "TSTypeReference":
      return TRACKED_TYPES.includes(referenceName(type.typeName));
    case "TSUnionType":
      return type.types.every(isTrackedType);
    case "TSIntersectionType":
      return type.types.some(isTrackedType);
    default:
      return false;
  }
}

/**
 * Whether `node` names a parameter or variable this file declares with a
 * tracked client's type (`prisma: Tracked<Db>`, `const client:
 * TrackedTransaction<Db> = tx`): the compiler holds it to the tracked client,
 * whatever it is named. A destructured binding, a member and a name declared
 * elsewhere are not read.
 */
export function declaredTracked(context, node) {
  const receiver = unwrap(node);
  if (receiver?.type !== "Identifier") {
    return false;
  }
  const definitions = resolveVariable(context, receiver)?.defs ?? [];
  return (
    definitions.length > 0 &&
    definitions.every((definition) =>
      isTrackedType(definition.name?.typeAnnotation?.typeAnnotation),
    )
  );
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
    (context !== undefined && declaredTracked(context, receiver) ? receiver.name : undefined);
  if (client === undefined) {
    return undefined;
  }
  return { call, client, model, method, args: call.arguments, receiver };
}
