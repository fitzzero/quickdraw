// Every contract member says what it is for: a `describe` on each
// `query(...)` and `mutation(...)`, on the contract itself and on each of its
// collections, streams, channels and events. The MCP bridge uses a method's
// describe as its tool's description (without one an agent sees only
// `service.method (query)`), and `quickdraw-docs` leads each section of the
// API docs with it. The 4.x codemod writes none, so a migrated contract has
// one report per member until someone writes them; a warning in the base
// config, `"error"` once an app has caught up.
//
// Found by shape: a call of `query`, `mutation` or `defineContract` imported
// from `@fitzzero/quickdraw-core` under any local name, or of a namespace
// import's member. Only object literals are checked: a spread (a kit's
// contract half supplies its own describes, and so may a shared options
// object) or a definition built elsewhere is left alone, and so is a
// describe that is not a static string. A static describe needs `minWords`
// words (default 3, the length of the kits' shortest). Test files are not
// checked.

import { keyName, memberName, staticString, unwrap } from "../lib/ast.mjs";
import { FILE_OPTIONS, TEST_FILES, inScope } from "../lib/files.mjs";

const CORE = "@fitzzero/quickdraw-core";
const METHODS = new Set(["query", "mutation"]);
const CONTRACT = "defineContract";
const NAMES = new Set([...METHODS, CONTRACT]);
/** The contract's members besides its methods, and what one of each is called in a message. */
const MEMBERS = {
  collections: "collection",
  streams: "stream",
  channels: "channel",
  events: "event",
};
const DEFAULT_MIN_WORDS = 3;

function importedName(specifier) {
  return specifier.imported.type === "Identifier"
    ? specifier.imported.name
    : specifier.imported.value;
}

/** Records the local names of `query`, `mutation` and `defineContract`, and of core namespaces. */
function collectImport(node, locals, namespaces) {
  if (node.source.value !== CORE) {
    return;
  }
  for (const specifier of node.specifiers) {
    if (specifier.type === "ImportSpecifier" && NAMES.has(importedName(specifier))) {
      locals.set(specifier.local.name, importedName(specifier));
    } else if (specifier.type === "ImportNamespaceSpecifier") {
      namespaces.add(specifier.local.name);
    }
  }
}

/** Which of the core's builders `callee` calls, if any. */
function builderOf(callee, locals, namespaces) {
  if (callee.type === "Identifier") {
    return locals.get(callee.name);
  }
  if (callee.type !== "MemberExpression") {
    return undefined;
  }
  const name = memberName(callee);
  const object = unwrap(callee.object);
  return NAMES.has(name) && object.type === "Identifier" && namespaces.has(object.name)
    ? name
    : undefined;
}

function wordCount(text) {
  return text.split(/\s+/).filter((word) => word !== "").length;
}

/**
 * Reports `object`, the definition of `member`, when it has no `describe`
 * (and spreads nothing that could hold one) or a static one that is too
 * short. `at` is the node a missing describe is reported on.
 */
function checkDefinition(context, object, member, at, minWords) {
  let describe;
  for (const property of object.properties) {
    if (property.type === "SpreadElement") {
      if (describe === undefined) {
        describe = null;
      }
    } else if (keyName(property) === "describe") {
      describe = property;
    }
  }
  if (describe === undefined) {
    context.report({ node: at, messageId: "missing", data: { member } });
    return;
  }
  const text = describe === null ? undefined : staticString(describe.value);
  if (text !== undefined && wordCount(text) < minWords) {
    context.report({
      node: describe.value,
      messageId: "short",
      data: { member, count: String(wordCount(text)), minWords: String(minWords) },
    });
  }
}

/** The object literal `node` is, through parentheses and type assertions, if it is one. */
function objectLiteral(node) {
  const value = unwrap(node);
  return value?.type === "ObjectExpression" ? value : undefined;
}

/** A method call's name: the key it is written under (`get: query(...)`), if any. */
function methodLabel(call, kind) {
  const parent = call.parent;
  const name = parent?.type === "Property" && parent.value === call ? keyName(parent) : undefined;
  return name === undefined ? `this ${kind}` : `method "${name}"`;
}

function checkContract(context, call, minWords) {
  const definition = objectLiteral(call.arguments[1]);
  if (definition === undefined) {
    return;
  }
  const name = staticString(call.arguments[0]);
  checkDefinition(
    context,
    definition,
    name === undefined ? "this contract" : `contract "${name}"`,
    call.callee,
    minWords,
  );
  for (const property of definition.properties) {
    const kind = property.type === "Property" ? MEMBERS[keyName(property)] : undefined;
    const members = kind === undefined ? undefined : objectLiteral(property.value);
    for (const entry of members?.properties ?? []) {
      const memberDefinition = entry.type === "Property" ? objectLiteral(entry.value) : undefined;
      const entryName = entry.type === "Property" ? keyName(entry) : undefined;
      if (memberDefinition !== undefined && entryName !== undefined) {
        checkDefinition(context, memberDefinition, `${kind} "${entryName}"`, entry.key, minWords);
      }
    }
  }
}

/** @type {import('eslint').Rule.RuleModule} */
export default {
  meta: {
    type: "suggestion",
    docs: {
      description:
        "Require a `describe` on every contract member: the contract, its methods, collections, streams, channels and events.",
    },
    messages: {
      missing:
        "{{ member }} has no `describe`. Say what it is for in a sentence or two: the MCP bridge uses a method's describe as its tool's description, and quickdraw-docs leads the member's section with it.",
      short:
        "{{ member }}'s `describe` has {{ count }} word(s); write at least {{ minWords }}, a sentence an agent can act on.",
    },
    schema: [
      {
        type: "object",
        properties: {
          ...FILE_OPTIONS,
          minWords: {
            type: "integer",
            minimum: 1,
            description: `The fewest words a static describe may have (default ${DEFAULT_MIN_WORDS}).`,
          },
        },
        additionalProperties: false,
      },
    ],
  },
  create(context) {
    const options = context.options[0] ?? {};
    if (!inScope(context, options, { ignore: TEST_FILES })) {
      return {};
    }
    const minWords = options.minWords ?? DEFAULT_MIN_WORDS;
    const locals = new Map();
    const namespaces = new Set();
    return {
      ImportDeclaration: (node) => collectImport(node, locals, namespaces),
      CallExpression(node) {
        const builder = builderOf(unwrap(node.callee), locals, namespaces);
        if (builder === CONTRACT) {
          checkContract(context, node, minWords);
        } else if (METHODS.has(builder)) {
          const definition = objectLiteral(node.arguments[0]);
          if (definition !== undefined) {
            checkDefinition(context, definition, methodLabel(node, builder), node.callee, minWords);
          }
        }
      },
    };
  },
};
