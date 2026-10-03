// A nested write (`data: { labels: { create: [...] } }`) reaches the tracked
// client only as the parent row's write, so the related rows' changes are
// never sent (RFC 0003 section 5.2). The runtime warns in development; this
// rule catches the same shapes before they run. Like the runtime check it
// reads shapes, not the schema: `set` counts only when it is given objects
// (a relation), not a scalar or a scalar list.

import { getProperty, keyName, unwrap } from "../lib/ast.mjs";
import { CLIENTS_OPTION, TRACKED_CLIENTS, modelCall } from "../lib/prisma.mjs";

const NESTED_KEYS = new Set([
  "create",
  "createMany",
  "connect",
  "connectOrCreate",
  "disconnect",
  "set",
  "update",
  "updateMany",
  "upsert",
  "delete",
  "deleteMany",
]);

/** Whether a `set` value takes rows to connect (objects) rather than a scalar. */
function isRelationSet(value) {
  const node = unwrap(value);
  if (node.type === "ObjectExpression") {
    return true;
  }
  return (
    node.type === "ArrayExpression" &&
    node.elements.some((element) => element !== null && unwrap(element).type === "ObjectExpression")
  );
}

/** The nested operation a field's value performs, if any. */
function nestedOperation(value) {
  for (const property of value.properties) {
    if (property.type !== "Property") {
      continue;
    }
    const name = keyName(property);
    if (name !== undefined && NESTED_KEYS.has(name)) {
      if (name !== "set" || isRelationSet(property.value)) {
        return name;
      }
    }
  }
  return undefined;
}

/** The `data`-like objects of a write's argument: `data`, or `create` and `update` for an upsert. */
function writtenObjects(method, argument) {
  let keys = [];
  if (method === "upsert") {
    keys = ["create", "update"];
  } else if (method === "create" || method === "update") {
    keys = ["data"];
  }
  return keys
    .map((key) => getProperty(argument, key))
    .filter((property) => property !== undefined)
    .map((property) => unwrap(property.value))
    .filter((value) => value.type === "ObjectExpression");
}

/** @type {import('eslint').Rule.RuleModule} */
export default {
  meta: {
    type: "problem",
    docs: {
      description:
        "Disallow nested relation writes through the tracked client: they are not tracked.",
    },
    messages: {
      nestedWrite:
        "`{{ field }}: { {{ operation }} }` is a nested write: only the `{{ model }}` row is tracked, so subscribers of the related rows hear nothing. " +
        "Write the related rows through their own model (in the same `db.$transaction`), set a foreign key column directly, or record them with `ctx.touch(model, ids)`.",
    },
    schema: [
      {
        type: "object",
        properties: { clients: CLIENTS_OPTION },
        additionalProperties: false,
      },
    ],
  },
  create(context) {
    const clients = context.options[0]?.clients ?? TRACKED_CLIENTS;
    return {
      CallExpression(node) {
        const call = modelCall(node, clients);
        const argument = call?.args[0] === undefined ? undefined : unwrap(call.args[0]);
        if (argument?.type !== "ObjectExpression") {
          return;
        }
        for (const data of writtenObjects(call.method, argument)) {
          for (const field of data.properties) {
            const value = field.type === "Property" ? unwrap(field.value) : undefined;
            const operation =
              value?.type === "ObjectExpression" ? nestedOperation(value) : undefined;
            if (operation !== undefined) {
              context.report({
                node: field,
                messageId: "nestedWrite",
                data: { field: keyName(field) ?? "[field]", operation, model: call.model },
              });
            }
          }
        }
      },
    };
  },
};
