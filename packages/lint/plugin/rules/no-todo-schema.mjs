// `todoSchema<T>()` is the placeholder `@fitzzero/quickdraw-codemod` writes
// where a 4.x method had no schema (and for 4.x DTOs): it types its value as
// `T` and validates nothing, so a contract holding one accepts any input.
// Every use is reported, as a warning in the base config, until a real
// schema replaces it. Found by shape: a call of `todoSchema` imported from
// `@fitzzero/quickdraw-core` under any local name, or of a namespace import's
// `todoSchema` member.

import { memberName, unwrap } from "../lib/ast.mjs";

const CORE = "@fitzzero/quickdraw-core";
const NAME = "todoSchema";

function importedName(specifier) {
  return specifier.imported.type === "Identifier"
    ? specifier.imported.name
    : specifier.imported.value;
}

/** Records the local names `todoSchema` and the core namespace go by in this file. */
function collectImport(node, names, namespaces) {
  if (node.source.value !== CORE) {
    return;
  }
  for (const specifier of node.specifiers) {
    if (specifier.type === "ImportSpecifier" && importedName(specifier) === NAME) {
      names.add(specifier.local.name);
    } else if (specifier.type === "ImportNamespaceSpecifier") {
      namespaces.add(specifier.local.name);
    }
  }
}

/** Whether `callee` is `todoSchema` (by its local name) or `namespace.todoSchema`. */
function isTodoSchema(callee, names, namespaces) {
  if (callee.type === "Identifier") {
    return names.has(callee.name);
  }
  if (callee.type !== "MemberExpression" || memberName(callee) !== NAME) {
    return false;
  }
  const object = unwrap(callee.object);
  return object.type === "Identifier" && namespaces.has(object.name);
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
    },
    schema: [],
  },
  create(context) {
    const names = new Set();
    const namespaces = new Set();
    return {
      ImportDeclaration: (node) => collectImport(node, names, namespaces),
      CallExpression(node) {
        const callee = unwrap(node.callee);
        if (isTodoSchema(callee, names, namespaces)) {
          context.report({ node: callee, messageId: "todoSchema" });
        }
      },
    };
  },
};
