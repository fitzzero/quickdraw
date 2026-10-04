// Loading rows and then filtering them in JavaScript reads (and sends over
// the database connection) every row the filter throws away (RFC 0003
// section 14). This rule reports `(await db.x.findMany(...)).filter(...)`
// (and `.find`), and the two-statement form where the loaded array's only
// use is that one `.filter`/`.find` call. To prefer missing a case over
// flagging correct code, it reports only predicates a Prisma `where` can
// express: comparisons of the row's own fields with values that do not
// depend on the row, truthiness tests, `startsWith`/`endsWith`/`includes`,
// a list's `includes(row.field)`, and `&&`/`||` of those.

import { FILE_OPTIONS, SERVER_FILES, TEST_FILES, inScope } from "../lib/files.mjs";
import { memberName, mentions, unwrap } from "../lib/ast.mjs";
import { ALL_CLIENTS, CLIENTS_OPTION, modelCall } from "../lib/prisma.mjs";

const FILTER_METHODS = new Set(["filter", "find"]);
const COMPARISONS = new Set(["===", "!==", "==", "!=", "<", "<=", ">", ">="]);
const STRING_TESTS = new Set(["startsWith", "endsWith", "includes"]);

/** The `findMany` call an awaited expression loads, if any. */
function loadedFindMany(node, clients) {
  const awaited = unwrap(node);
  if (awaited?.type !== "AwaitExpression") {
    return undefined;
  }
  const call = modelCall(awaited.argument, clients);
  return call?.method === "findMany" ? call : undefined;
}

/** Whether `node` is a direct field of the row: `row.status`. */
function isField(node, row) {
  const value = unwrap(node);
  return (
    value.type === "MemberExpression" &&
    !value.computed &&
    unwrap(value.object).type === "Identifier" &&
    unwrap(value.object).name === row
  );
}

/** Whether a predicate's condition maps onto a Prisma `where`. */
function expressible(context, condition, row) {
  const node = unwrap(condition);
  const free = (value) => !mentions(context, value, new Set([row]));
  switch (node.type) {
    case "LogicalExpression":
      return (
        node.operator !== "??" &&
        expressible(context, node.left, row) &&
        expressible(context, node.right, row)
      );
    case "UnaryExpression":
      return node.operator === "!" && isField(node.argument, row);
    case "MemberExpression":
      return isField(node, row);
    case "BinaryExpression":
      return (
        COMPARISONS.has(node.operator) &&
        ((isField(node.left, row) && free(node.right)) ||
          (isField(node.right, row) && free(node.left)))
      );
    case "CallExpression": {
      const callee = unwrap(node.callee);
      if (callee.type !== "MemberExpression" || node.arguments.length !== 1) {
        return false;
      }
      const method = memberName(callee);
      const [argument] = node.arguments;
      if (STRING_TESTS.has(method) && isField(callee.object, row) && free(argument)) {
        return true;
      }
      return method === "includes" && free(callee.object) && isField(argument, row);
    }
    default:
      return false;
  }
}

/** Whether a `.filter`/`.find` callback is a predicate a `where` can express. */
function isWherePredicate(context, callback) {
  const fn = callback === undefined ? undefined : unwrap(callback);
  if (fn?.type !== "ArrowFunctionExpression" && fn?.type !== "FunctionExpression") {
    return false;
  }
  if (fn.params.length !== 1 || fn.params[0].type !== "Identifier") {
    return false;
  }
  let condition = fn.body;
  if (fn.body.type === "BlockStatement") {
    const [statement] = fn.body.body;
    if (
      fn.body.body.length !== 1 ||
      statement.type !== "ReturnStatement" ||
      statement.argument === null
    ) {
      return false;
    }
    condition = statement.argument;
  }
  return expressible(context, condition, fn.params[0].name);
}

/** The `.filter(...)`/`.find(...)` call whose object is `node`, if any. */
function filterCallOn(node) {
  const member = node.parent;
  if (member?.type !== "MemberExpression" || member.object !== node) {
    return undefined;
  }
  const call = member.parent;
  if (call?.type !== "CallExpression" || call.callee !== member) {
    return undefined;
  }
  return FILTER_METHODS.has(memberName(member)) ? call : undefined;
}

/** @type {import('eslint').Rule.RuleModule} */
export default {
  meta: {
    type: "problem",
    docs: {
      description:
        "Disallow loading rows with `findMany` and then filtering them in JavaScript; filter in `where`.",
    },
    messages: {
      loadThenFilter:
        "This reads every `{{ model }}` row `findMany` matches, then keeps some of them with `.{{ method }}()` in JavaScript. " +
        "Move the condition into `findMany({ where })` (or `findFirst` for `.find`) so the database returns only the rows you keep.",
    },
    schema: [
      {
        type: "object",
        properties: { ...FILE_OPTIONS, clients: CLIENTS_OPTION },
        additionalProperties: false,
      },
    ],
  },
  create(context) {
    const options = context.options[0] ?? {};
    if (!inScope(context, options, { files: SERVER_FILES, ignore: TEST_FILES })) {
      return {};
    }
    const clients = options.clients ?? ALL_CLIENTS;

    const check = (filterCall, load) => {
      if (isWherePredicate(context, filterCall.arguments[0])) {
        context.report({
          node: filterCall,
          messageId: "loadThenFilter",
          data: { model: load.model, method: memberName(filterCall.callee) },
        });
      }
    };

    return {
      CallExpression(node) {
        const callee = unwrap(node.callee);
        if (callee.type !== "MemberExpression" || !FILTER_METHODS.has(memberName(callee))) {
          return;
        }
        const load = loadedFindMany(callee.object, clients);
        if (load !== undefined) {
          check(node, load);
        }
      },
      VariableDeclarator(node) {
        if (node.id.type !== "Identifier" || node.parent?.kind !== "const" || node.init === null) {
          return;
        }
        const load = loadedFindMany(node.init, clients);
        if (load === undefined) {
          return;
        }
        const [variable] = context.sourceCode.getDeclaredVariables(node);
        const reads = variable?.references.filter((reference) => !reference.init) ?? [];
        const filterCall = reads.length === 1 ? filterCallOn(reads[0].identifier) : undefined;
        if (filterCall !== undefined) {
          check(filterCall, load);
        }
      },
    };
  },
};
