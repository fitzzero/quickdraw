// Who may call a method is declared in its `access` (RFC 0003 section 4),
// and the dispatcher refuses an anonymous caller with `UNAUTHENTICATED`
// before the handler runs, on every transport. This rule reports the inline
// version inside a handler: `if (!ctx.principal) throw ...` and its variants
// (`!ctx.principal?.userId`, `ctx.principal == null`, a destructured
// `principal`, either side of `||`). A guard that returns instead of
// throwing (a public method answering anonymous callers differently) is not
// reported.

import { chainNames, isFunction, keyName, unwrap } from "../lib/ast.mjs";

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

/** Whether `node` runs inside a method's `handler`. */
function insideHandler(context, node) {
  return context.sourceCode.getAncestors(node).some((ancestor) => {
    if (!isFunction(ancestor)) {
      return false;
    }
    const holder = ancestor.parent;
    return (
      (holder?.type === "Property" || holder?.type === "MethodDefinition") &&
      holder.value === ancestor &&
      keyName(holder) === "handler"
    );
  });
}

/** @type {import('eslint').Rule.RuleModule} */
export default {
  meta: {
    type: "suggestion",
    docs: {
      description:
        "Disallow checking `ctx.principal` by hand in a handler: declare who may call in the method's `access`.",
    },
    messages: {
      inlineGuard:
        "Don't check `ctx.principal` by hand: declare it in the method's `access` (`\"authenticated\"`, `{ service }`, `{ entry }`, `{ scope, of, id }` or `custom(fn)`). " +
        "The dispatcher then refuses anonymous callers with `UNAUTHENTICATED` before the handler runs, on every transport, and `ctx.principal` is typed as present.",
    },
    schema: [],
  },
  create(context) {
    return {
      IfStatement(node) {
        if (
          checksMissingPrincipal(node.test) &&
          throwsFirst(node.consequent) &&
          insideHandler(context, node)
        ) {
          context.report({ node: node.test, messageId: "inlineGuard" });
        }
      },
    };
  },
};
