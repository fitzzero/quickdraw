// A service that writes by hand what a kit implements (RFC 0003 section 12):
// the kits' methods check access on every row they touch, page, filter by
// declared fields and stay live, once, in the framework; a hand-written copy
// has to get each of those right again. Inside a `defineService(contract, {
// model, methods })` whose `model` is a string (a literal, or a `const` of
// one in the file) and whose `methods` spreads no kit, a method written out
// by hand whose name is a kit method's (`get`, `list`, `create`, `search`,
// `share`, `adminList`, ...) or names the service's model the way a
// hand-written kit method does (`getTask`, `listTasks`, `createTask`,
// `updateTask`, `deleteTask` for model `"task"`) is reported, naming the kit
// and the line that opts in. `remove` is the sharing kit's only on a
// membership model (`projectMember`) or beside another sharing method
// (`share`, `invite`, `listMembers`, ...); elsewhere it deletes the
// service's own row. A service that already spreads a kit chose what it
// hand-writes; a service without a string `model` cannot use a kit.
//
// A spread is a kit's unless the rule can read it as hand-written methods:
// `...crud.handlers(...)` under any name, a variable (`...taskCrud`,
// `...handlers`, imported or bound to a call) and any other call are kits; a
// `const` bound to an object literal in the file is a kit when that object
// spreads one. A method's implementation is written by hand when it is an
// object literal that spreads nothing, a function, a name bound elsewhere
// (`methods: { getTask }`, a method module's export), or a call wrapping an
// object literal or a function (`get: withAudit({ access, handler })`);
// `{ ...kitMethods.get, rowless: true }`, `kitMethods.get` and `makeGet()`
// are the kit's own. A comment right above the method, `// quickdraw:
// hand-written because <reason>`, keeps it quiet: the reason is the point.
// Test files are not checked.
//
// A service that spreads a kit is checked too, for what that spread
// enables in plain sight (finding F7.7 of the quickdraw-chat review: a
// hand-written `getNote` sat beside a crud kit that already served `get`):
// `crud.handlers(contract, { access: { get, ... } })` enables the methods
// its `access` literal names, `search.handlers(...)` enables `search`, and
// `admin.handlers(...)` every admin method. A hand-written method whose kit
// shape is one of those (`get`, or `getNote` for model `"note"`) is
// reported as a duplicate. The kit is the spread call's object as the file
// imports it (`crud`, `crudKit` for `{ crud as crudKit }`), or its own name.

import {
  getProperty,
  isDefineService,
  isFunction,
  keyName,
  memberName,
  resolveVariable,
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

/** The admin kit's methods: `admin.handlers` enables every one of them. */
const ADMIN_METHODS = [...KIT_METHODS].filter(([, kit]) => kit === ADMIN).map(([name]) => name);

/** The kits by the name of the object whose `handlers` a service spreads. */
const KITS_BY_OBJECT = new Map([
  ["crud", CRUD],
  ["search", SEARCH],
  ["sharing", SHARING],
  ["admin", ADMIN],
]);

/** The sharing kit's other methods: beside one of them, `remove` removes a member. */
const SHARING_SIBLINGS = new Set(
  [...KIT_METHODS]
    .filter(([name, kit]) => kit === SHARING && name !== "remove")
    .map(([name]) => name),
);

/** A model of member rows (`member`, `projectMember`, `membership`): its `remove` removes a member. */
const MEMBERSHIP_MODEL = /member/iu;

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
 * The kit method a name means, `{ method, kit }`, for a service of `model`
 * whose methods are named `methods`; `undefined` for none. Exported for
 * `@fitzzero/quickdraw-codemod`'s test, which keeps its own copy (it marks
 * migrated methods of these shapes) in step.
 */
export function kitShape(name, model, methods = []) {
  if (
    name === "remove" &&
    !MEMBERSHIP_MODEL.test(model) &&
    !methods.some((method) => SHARING_SIBLINGS.has(method))
  ) {
    return undefined;
  }
  const kit = KIT_METHODS.get(name);
  if (kit !== undefined) {
    return { method: name, kit };
  }
  const shapes = {
    [`get${capitalized(model)}`]: "get",
    [`list${capitalized(plural(model))}`]: "list",
    [`create${capitalized(model)}`]: "create",
    [`update${capitalized(model)}`]: "update",
    [`delete${capitalized(model)}`]: "delete",
  };
  return Object.hasOwn(shapes, name) ? { method: shapes[name], kit: CRUD } : undefined;
}

/** The initializer of the `const name = ...` an identifier names in this file, or `undefined`. */
function constInit(context, identifier) {
  const variable = resolveVariable(context, identifier);
  const definition = variable?.defs.length === 1 ? variable.defs[0] : undefined;
  const declarator = definition?.type === "Variable" ? definition.node : undefined;
  return definition?.parent?.kind === "const" &&
    declarator?.id.type === "Identifier" &&
    declarator.init !== null
    ? declarator.init
    : undefined;
}

/**
 * Whether a spread value is a kit's: anything but an object literal (or a
 * `const` bound to one in this file) that spreads no kit itself. A call, a
 * member and a variable the rule cannot see into are a kit.
 */
function isKitSpread(context, node, seen = new Set()) {
  const value = unwrap(node);
  if (value.type === "ObjectExpression") {
    return value.properties.some(
      (entry) => entry.type === "SpreadElement" && isKitSpread(context, entry.argument, seen),
    );
  }
  if (value.type !== "Identifier") {
    return true;
  }
  const init = constInit(context, value);
  if (init === undefined) {
    return true;
  }
  if (seen.has(init)) {
    return false;
  }
  seen.add(init);
  return isKitSpread(context, init, seen);
}

/**
 * Whether a method's implementation is written by hand: an object literal
 * spreading nothing, a function, a name, or a call wrapping an object literal
 * or a function (`withAudit({ access, handler })`, through nested calls).
 */
function isHandWrittenValue(node, wrapped = false) {
  const value = unwrap(node);
  if (value.type === "Identifier") {
    return !wrapped;
  }
  if (value.type === "ObjectExpression") {
    return value.properties.every((entry) => entry.type !== "SpreadElement");
  }
  if (value.type === "CallExpression") {
    return value.arguments.some((argument) => isHandWrittenValue(argument, true));
  }
  return isFunction(value);
}

/** Whether a `methods` property's implementation is written by hand. */
function isHandWritten(property) {
  return property.shorthand || isHandWrittenValue(property.value);
}

/** The name `identifier` is imported under in this file (`crud` for `{ crud as crudKit }`), or its own. */
function importedName(context, identifier) {
  const variable = resolveVariable(context, identifier);
  const definition = variable?.defs.length === 1 ? variable.defs[0] : undefined;
  const specifier = definition?.type === "ImportBinding" ? definition.node : undefined;
  if (specifier?.type === "ImportSpecifier") {
    return specifier.imported.name ?? specifier.imported.value;
  }
  return identifier.name;
}

/**
 * What a spread kit call enables in plain sight: `{ kit, methods }` for
 * `crud.handlers(contract, { access: { get, ... } })` (the methods its
 * `access` literal names), `search.handlers(...)` and `admin.handlers(...)`;
 * `undefined` for anything else, whose methods the rule cannot see.
 */
function enabledBy(context, node) {
  const call = unwrap(node);
  const callee = call.type === "CallExpression" ? unwrap(call.callee) : undefined;
  const object = callee?.type === "MemberExpression" ? unwrap(callee.object) : undefined;
  if (object?.type !== "Identifier" || memberName(callee) !== "handlers") {
    return undefined;
  }
  const kit = KITS_BY_OBJECT.get(importedName(context, object));
  if (kit === SEARCH) {
    return { kit, methods: new Set(["search"]) };
  }
  if (kit === ADMIN) {
    return { kit, methods: new Set(ADMIN_METHODS) };
  }
  const options = call.arguments[1] === undefined ? undefined : unwrap(call.arguments[1]);
  const access =
    kit === CRUD && options?.type === "ObjectExpression"
      ? getProperty(options, "access")
      : undefined;
  const forms = access === undefined ? undefined : unwrap(access.value);
  if (forms?.type !== "ObjectExpression") {
    return undefined;
  }
  const names = forms.properties.map((property) =>
    property.type === "Property" ? keyName(property) : undefined,
  );
  return { kit, methods: new Set(names.filter((name) => name !== undefined)) };
}

/** A `model` value's string: a literal, or the `const` of one it names in this file. */
function modelName(context, node) {
  const value = unwrap(node);
  if (value?.type === "Identifier") {
    const init = constInit(context, value);
    return init === undefined ? undefined : staticString(init);
  }
  return staticString(value);
}

/** The `methods` object and the string `model` of a `defineService` call, when both are written out. */
function serviceOf(context, node) {
  const definition = unwrap(node.arguments[1]);
  if (definition?.type !== "ObjectExpression") {
    return undefined;
  }
  const modelProperty = getProperty(definition, "model");
  const methodsProperty = getProperty(definition, "methods");
  const model = modelProperty === undefined ? undefined : modelName(context, modelProperty.value);
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
      duplicatesKit:
        "`{{ name }}` is written by hand beside `{{ optIn }}`, which already serves {{ kit }}'s `{{ method }}` here: the kit's checks access on every row it touches, pages and stays live. " +
        "Call `{{ method }}` and remove this one, or, if it must be hand-written, say why in a `// quickdraw: hand-written because ...` comment above it.",
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
        const service = isDefineService(node) ? serviceOf(context, node) : undefined;
        const { properties } = service?.methods ?? { properties: [] };
        const spreads = properties.filter(
          (property) =>
            property.type === "SpreadElement" && isKitSpread(context, property.argument),
        );
        if (service === undefined) {
          return;
        }
        // With a kit spread, only what it enables in plain sight is a duplicate.
        const enabled = spreads.flatMap((spread) => enabledBy(context, spread.argument) ?? []);
        const names = properties.map((property) =>
          property.type === "Property" ? keyName(property) : undefined,
        );
        for (const property of properties) {
          const name = property.type === "Property" ? keyName(property) : undefined;
          const shape = name === undefined ? undefined : kitShape(name, service.model, names);
          if (shape === undefined || !isHandWritten(property) || explained(context, property)) {
            continue;
          }
          const duplicated = enabled.some(
            ({ kit, methods }) => kit === shape.kit && methods.has(shape.method),
          );
          if (spreads.length > 0 && !duplicated) {
            continue;
          }
          context.report({
            node: property.key,
            messageId: duplicated ? "duplicatesKit" : "preferKit",
            data: { name, method: shape.method, ...shape.kit },
          });
        }
      },
    };
  },
};
