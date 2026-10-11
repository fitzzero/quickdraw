// `todoSchema<T>()` is the placeholder `@fitzzero/quickdraw-codemod` writes
// where a 4.x method had no schema (and for 4.x DTOs): it types its value as
// `T` and validates nothing, so a contract holding one accepts any input.
// Every use is reported, as a warning in the base config, until a real
// schema replaces it. Found by shape: a call of `todoSchema` imported from
// `@fitzzero/quickdraw-core` under any local name, or of a namespace import's
// `todoSchema` member.
//
// A placeholder without `keys` that is the `input` of `query()` or
// `mutation()` gets a second message: its JSON Schema names no keys, so
// defineService's id-reach (rowless) check cannot see an `id` in it and
// refuses nothing. Whether the method's access form checks a row is in the
// service file, which this rule does not read, so it says so for every form.

import { getProperty, hasSpread, memberName, unwrap } from "../lib/ast.mjs";

const CORE = "@fitzzero/quickdraw-core";
const NAME = "todoSchema";
const METHODS = new Set(["query", "mutation"]);

function importedName(specifier) {
  return specifier.imported.type === "Identifier"
    ? specifier.imported.name
    : specifier.imported.value;
}

/**
 * Records the local names `todoSchema`, `query`, `mutation` and the core
 * namespace go by in this file. `names` maps a local name to the imported one.
 */
function collectImport(node, names, namespaces) {
  if (node.source.value !== CORE) {
    return;
  }
  for (const specifier of node.specifiers) {
    if (specifier.type === "ImportSpecifier") {
      const imported = importedName(specifier);
      if (imported === NAME || METHODS.has(imported)) {
        names.set(specifier.local.name, imported);
      }
    } else if (specifier.type === "ImportNamespaceSpecifier") {
      namespaces.add(specifier.local.name);
    }
  }
}

/** The core export `callee` calls (by its local name or as `namespace.name`), if any. */
function coreName(callee, names, namespaces) {
  if (callee.type === "Identifier") {
    return names.get(callee.name);
  }
  if (callee.type !== "MemberExpression") {
    return undefined;
  }
  const object = unwrap(callee.object);
  return object.type === "Identifier" && namespaces.has(object.name)
    ? memberName(callee)
    : undefined;
}

/**
 * Whether a `todoSchema(...)` call surely names no keys: no options, or an
 * options literal without `keys` (or with an empty list). Options it cannot
 * read (a variable, a spread) may name some, so they do not count.
 */
function isKeyless(call) {
  const options = call.arguments[0];
  if (options === undefined) {
    return true;
  }
  const object = unwrap(options);
  if (object.type !== "ObjectExpression" || hasSpread(object)) {
    return false;
  }
  const keys = getProperty(object, "keys");
  if (keys === undefined) {
    return true;
  }
  const list = unwrap(keys.value);
  return list.type === "ArrayExpression" && list.elements.length === 0;
}

/** Whether `call` (through any wrapping assertion) is the `input` of a core `query()` or `mutation()`. */
function isMethodInput(call, names, namespaces) {
  let value = call;
  while (value.parent !== null && value.parent !== undefined && unwrap(value.parent) === call) {
    value = value.parent;
  }
  const property = value.parent;
  if (property?.type !== "Property" || property.value !== value) {
    return false;
  }
  if (getProperty(property.parent, "input") !== property) {
    return false;
  }
  const method = property.parent.parent;
  return (
    method?.type === "CallExpression" &&
    method.arguments[0] === property.parent &&
    METHODS.has(coreName(unwrap(method.callee), names, namespaces))
  );
}

/** @type {import('eslint').Rule.RuleModule} */
export default {
  meta: {
    type: "suggestion",
    docs: {
      description:
        "Report `todoSchema()`, the 4.x migration's placeholder schema, until a real schema replaces it.",
    },
    messages: {
      todoSchema:
        "`todoSchema()` is a placeholder left by the 4.x migration: it validates nothing, so any value passes as its type. " +
        "Replace it with a real schema (Zod 4.2 or later where JSON Schema is read: MCP tools, admin metadata, projection keys).",
      keylessInput:
        "`todoSchema()` is a placeholder left by the 4.x migration: it validates nothing, so any value passes as its type. " +
        "Without `keys`, it also hides this input's keys from defineService's id-reach (rowless) check, " +
        "which refuses an `id` input under an access form that checks no row; give it keys " +
        '(`todoSchema<T>({ keys: ["id", ...] })`) until a real schema (Zod 4.2 or later) replaces it.',
    },
    schema: [],
  },
  create(context) {
    const names = new Map();
    const namespaces = new Set();
    return {
      ImportDeclaration: (node) => collectImport(node, names, namespaces),
      CallExpression(node) {
        const callee = unwrap(node.callee);
        if (coreName(callee, names, namespaces) !== NAME) {
          return;
        }
        const keyless = isKeyless(node) && isMethodInput(node, names, namespaces);
        context.report({ node: callee, messageId: keyless ? "keylessInput" : "todoSchema" });
      },
    };
  },
};
