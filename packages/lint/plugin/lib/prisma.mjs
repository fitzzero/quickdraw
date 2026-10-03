// Recognizing database calls by shape. The tracked client is conventionally
// named `db` (the handler argument, or the app's `trackPrisma(...)` client in
// jobs), the client inside an interactive transaction `tx`, and the untracked
// Prisma client `prisma`. Rules take the names as options.

import { memberName, unwrap } from "./ast.mjs";

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

/**
 * A model operation on one of `clients`: `db.task.update(...)` gives
 * `{ client: "db", model: "task", method: "update", args }`. A computed
 * model (`db[name]`) and the client's own `$` methods are not model calls.
 */
export function modelCall(node, clients) {
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
  const client = clientName(delegate.object, clients);
  if (client === undefined) {
    return undefined;
  }
  return { call, client, model, method, args: call.arguments };
}
