// Who may call a method is declared in its `access` (RFC 0003 section 4),
// and the dispatcher refuses an anonymous caller with `UNAUTHENTICATED`
// before the handler runs, on every transport. This rule reports the inline
// version inside a handler: `if (!ctx.principal) throw ...` and its variants
// (`!ctx.principal?.userId`, `ctx.principal == null`, a destructured
// `principal`, either side of `||`). A guard that returns instead of
// throwing (a public method answering anonymous callers differently) is not
// reported.
//
// The kinds of principal that may call are declared beside `access`, as
// `kinds` (section 4.1), so it also reports a guard on the principal's kind
// that throws: `if (ctx.principal.kind !== "user") throw ...`, a comparison
// with a kind either way round, `!KINDS.includes(ctx.principal.kind)`, either
// side of `||`. A kind tested with `&&` beside something else (agents may
// not set this status) is a check `kinds` cannot make, and a `"public"`
// method takes no `kinds`, so neither is reported.

import { chainNames, getProperty, isFunction, keyName, memberName, unwrap } from "../lib/ast.mjs";

/** Whether `node` reads the principal: `ctx.principal`, `principal`, or their `userId`. */
function isPrincipal(node) {
  const value = unwrap(node);
  if (value.type !== "MemberExpression" && value.type !== "Identifier") {
    return false;
  }
  const names = chainNames(value);
  const at = names[0] === "ctx" ? 1 : 0;
  return names[at] === "principal" && names.length - at <= 2;
}

function isNullish(node) {
  const value = unwrap(node);
  return (
    (value.type === "Literal" && value.value === null && value.raw === "null") ||
    (value.type === "Identifier" && value.name === "undefined")
  );
}

/** Whether `node` reads the principal's kind: `ctx.principal.kind` or `principal.kind`. */
function isKind(node) {
  const value = unwrap(node);
  if (value.type !== "MemberExpression") {
    return false;
  }
  const names = chainNames(value);
  const at = names[0] === "ctx" ? 1 : 0;
  return names.length - at === 2 && names[at] === "principal" && names[at + 1] === "kind";
}

function isString(node) {
  const value = unwrap(node);
  return value.type === "Literal" && typeof value.value === "string";
}

/** Whether a condition tests the principal's kind and nothing it must hold beside it. */
function checksKind(test) {
  const node = unwrap(test);
  switch (node.type) {
    case "LogicalExpression":
      return node.operator === "||" && (checksKind(node.left) || checksKind(node.right));
    case "UnaryExpression":
      return node.operator === "!" && checksKind(node.argument);
    case "BinaryExpression":
      return (
        ["==", "===", "!=", "!=="].includes(node.operator) &&
        ((isKind(node.left) && isString(node.right)) || (isString(node.left) && isKind(node.right)))
      );
    case "CallExpression": {
      const callee = unwrap(node.callee);
      return (
        callee.type === "MemberExpression" &&
        memberName(callee) === "includes" &&
        node.arguments.length === 1 &&
        isKind(node.arguments[0])
      );
    }
    default:
      return false;
  }
}

/** Whether a condition is true when there is no principal. */
function checksMissingPrincipal(test) {
  const node = unwrap(test);
  switch (node.type) {
    case "LogicalExpression":
      return (
        node.operator === "||" &&
        (checksMissingPrincipal(node.left) || checksMissingPrincipal(node.right))
      );
    case "UnaryExpression":
      return node.operator === "!" && isPrincipal(node.argument);
    case "BinaryExpression":
      return (
        (node.operator === "==" || node.operator === "===") &&
        ((isPrincipal(node.left) && isNullish(node.right)) ||
          (isNullish(node.left) && isPrincipal(node.right)))
      );
    default:
      return false;
  }
}

function throwsFirst(statement) {
  if (statement.type === "ThrowStatement") {
    return true;
  }
  return statement.type === "BlockStatement" && statement.body[0]?.type === "ThrowStatement";
}

/** The `handler` property (or method) whose function `node` runs inside, or `undefined`. */
function handlerOf(context, node) {
  for (const ancestor of context.sourceCode.getAncestors(node)) {
    const holder = ancestor.parent;
    if (
      isFunction(ancestor) &&
      (holder?.type === "Property" || holder?.type === "MethodDefinition") &&
      holder.value === ancestor &&
      keyName(holder) === "handler"
    ) {
      return holder;
    }
  }
  return undefined;
}

/** Whether a method entry declares `access: "public"`, beside its `handler`. */
function isPublicMethod(handler) {
  const entry = handler.parent;
  if (entry?.type !== "ObjectExpression") {
    return false;
  }
  const access = getProperty(entry, "access");
  return access !== undefined && unwrap(access.value).value === "public";
}

/** Which guard a condition is, if any: a missing principal, or the principal's kind. */
function guardOf(test) {
  if (checksMissingPrincipal(test)) {
    return "inlineGuard";
  }
  return checksKind(test) ? "kindGuard" : undefined;
}

/** @type {import('eslint').Rule.RuleModule} */
export default {
  meta: {
    type: "suggestion",
    docs: {
      description:
        "Disallow checking `ctx.principal` or its kind by hand in a handler: declare who may call in the method's `access` and `kinds`.",
    },
    messages: {
      inlineGuard:
        "Don't check `ctx.principal` by hand: declare it in the method's `access` (`\"authenticated\"`, `{ service }`, `{ entry }`, `{ scope, of, id }` or `custom(fn)`). " +
        "The dispatcher then refuses anonymous callers with `UNAUTHENTICATED` before the handler runs, on every transport, and `ctx.principal` is typed as present.",
      kindGuard:
        'Don\'t check `ctx.principal.kind` by hand: declare the kinds that may call beside `access`, as `kinds: ["user"]` on the method, on its service, or on `initQuickdraw` for every service. ' +
        "The dispatcher then refuses every other kind with `FORBIDDEN` before the handler runs, on every transport and subscription, whatever its grants.",
    },
    schema: [],
  },
  create(context) {
    return {
      IfStatement(node) {
        const messageId = guardOf(node.test);
        if (messageId === undefined || !throwsFirst(node.consequent)) {
          return;
        }
        const handler = handlerOf(context, node);
        if (handler === undefined || (messageId === "kindGuard" && isPublicMethod(handler))) {
          return;
        }
        context.report({ node: node.test, messageId });
      },
    };
  },
};
