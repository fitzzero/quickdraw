// A service that writes by hand what a kit implements (RFC 0003 section 12):
// the kits' methods check access on every row they touch, page, filter by
// declared fields and stay live, once, in the framework; a hand-written copy
// has to get each of those right again. Inside a `defineService(contract, {
// model: "<literal>", methods })` whose `methods` spreads no kit's handlers
// (`...crud.handlers(...)`, `...search.handlers(...)`, any `....handlers(...)`
// spread), a method written out by hand whose name is a kit method's (`get`,
// `list`, `create`, `search`, `share`, `adminList`, ...) or names the
// service's model the way a hand-written kit method does (`getTask`,
// `listTasks`, `createTask` for model `"task"`) is reported, naming the kit
// and the line that opts in. A service that already spreads a kit chose what
// it hand-writes; a service without a literal `model` cannot use a kit.
//
// A method's implementation is written by hand when it is an object literal
// that spreads nothing, or a name bound elsewhere (`methods: { getTask }`, a
// method module's export); `{ ...kitMethods.get, rowless: true }` and
// `kitMethods.get` are the kit's own. A comment right above the method,
// `// quickdraw: hand-written because <reason>`, keeps it quiet: the reason
// is the point. Test files are not checked.

import {
  getProperty,
  isDefineService,
  keyName,
  memberName,
  staticString,
  unwrap,
} from "../lib/ast.mjs";
import { FILE_OPTIONS, TEST_FILES, inScope } from "../lib/files.mjs";

const CRUD = {
  kit: "the read/write kit",
  optIn: "...crud.handlers(contract, { access })",
  contract: "crud.contract",
};
const SEARCH = {
  kit: "the search kit",
  optIn: "...search.handlers(contract, { access })",
  contract: "search.contract",
};
const SHARING = {
  kit: "the sharing kit",
  optIn: "...sharing.handlers(contract)",
  contract: "sharing.contract",
};
const ADMIN = {
  kit: "the admin kit",
  optIn: "...admin.handlers(contract)",
  contract: "admin.contract",
};

/** The kits' method names, and the kit each belongs to. */
const KIT_METHODS = new Map([
  ...[
    "get",
    "getMany",
    "list",
    "create",
    "update",
    "delete",
    "reorder",
    "bulkUpdate",
    "bulkDelete",
  ].map((name) => [name, CRUD]),
  ["search", SEARCH],
  ...[
    "share",
    "shareByName",
    "unshare",
    "listShares",
    "invite",
    "inviteByName",
    "remove",
    "listMembers",
  ].map((name) => [name, SHARING]),
  ...["adminList", "adminGet", "adminCreate", "adminUpdate", "adminDelete", "adminMeta"].map(
    (name) => [name, ADMIN],
  ),
]);

const HAND_WRITTEN = /^\s*quickdraw:\s*hand-written because\s+\S/u;

function capitalized(word) {
  return word.charAt(0).toUpperCase() + word.slice(1);
}

/** A model name's plural, as a method name spells it: `task` gives `tasks`, `category` `categories`. */
function plural(word) {
  if (/[^aeiou]y$/u.test(word)) {
    return `${word.slice(0, -1)}ies`;
  }
  return /(?:s|x|z|ch|sh)$/u.test(word) ? `${word}es` : `${word}s`;
}

/**
 * The kit method a name means, `{ method, kit }`, for a service of `model`;
 * `undefined` for none. Exported for `@fitzzero/quickdraw-codemod`'s test,
 * which keeps its own copy (it marks migrated methods of these shapes) in step.
 */
export function kitShape(name, model) {
  const kit = KIT_METHODS.get(name);
  if (kit !== undefined) {
    return { method: name, kit };
  }
  const shapes = {
    [`get${capitalized(model)}`]: "get",
    [`list${capitalized(plural(model))}`]: "list",
    [`create${capitalized(model)}`]: "create",
  };
  return Object.hasOwn(shapes, name) ? { method: shapes[name], kit: CRUD } : undefined;
}

/** Whether a `methods` entry spreads a kit's handlers: `...crud.handlers(...)`, under any name. */
function spreadsKit(property) {
  if (property.type !== "SpreadElement") {
    return false;
  }
  const call = unwrap(property.argument);
  if (call.type !== "CallExpression") {
    return false;
  }
  const callee = unwrap(call.callee);
  return callee.type === "MemberExpression" && memberName(callee) === "handlers";
}

/** Whether a method's implementation is written by hand: an object literal spreading nothing, or a name. */
function isHandWritten(property) {
  if (property.shorthand) {
    return true;
  }
  const value = unwrap(property.value);
  if (value.type === "Identifier") {
    return true;
  }
  return (
    value.type === "ObjectExpression" &&
    value.properties.every((entry) => entry.type !== "SpreadElement")
  );
}

/** The `methods` object and the literal `model` of a `defineService` call, when both are written out. */
function serviceOf(node) {
  const definition = unwrap(node.arguments[1]);
  if (definition?.type !== "ObjectExpression") {
    return undefined;
  }
  const modelProperty = getProperty(definition, "model");
  const methodsProperty = getProperty(definition, "methods");
  const model = modelProperty === undefined ? undefined : staticString(modelProperty.value);
  const methods = methodsProperty === undefined ? undefined : unwrap(methodsProperty.value);
  if (model === undefined || model === "" || methods?.type !== "ObjectExpression") {
    return undefined;
  }
  return { model, methods };
}

function explained(context, property) {
  return context.sourceCode
    .getCommentsBefore(property)
    .some((comment) => HAND_WRITTEN.test(comment.value));
}

/** @type {import('eslint').Rule.RuleModule} */
export default {
  meta: {
    type: "suggestion",
    docs: {
      description:
        "Report a hand-written service method a kit implements (`get`, `list`, `create`, `getTask`, ...), in a service that uses no kit.",
    },
    messages: {
      preferKit:
        "`{{ name }}` is written by hand, and {{ kit }}'s `{{ method }}` implements it: `{{ optIn }}` (with `{{ contract }}` in the contract) checks access on every row it touches, pages and stays live. " +
        "Use the kit, or, if this method must be hand-written, say why in a `// quickdraw: hand-written because ...` comment above it.",
    },
    schema: [
      {
        type: "object",
        properties: { ...FILE_OPTIONS },
        additionalProperties: false,
      },
    ],
  },
  create(context) {
    const options = context.options[0] ?? {};
    if (!inScope(context, options, { ignore: TEST_FILES })) {
      return {};
    }
    return {
      CallExpression(node) {
        const service = isDefineService(node) ? serviceOf(node) : undefined;
        if (service === undefined || service.methods.properties.some(spreadsKit)) {
          return;
        }
        for (const property of service.methods.properties) {
          const name = property.type === "Property" ? keyName(property) : undefined;
          const shape = name === undefined ? undefined : kitShape(name, service.model);
          if (shape === undefined || !isHandWritten(property) || explained(context, property)) {
            continue;
          }
          context.report({
            node: property.key,
            messageId: "preferKit",
            data: { name, method: shape.method, ...shape.kit },
          });
        }
      },
    };
  },
};
