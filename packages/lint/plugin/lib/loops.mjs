// Finding the per-item loop a node runs in, for the performance rules.

import { isFunction, memberName, patternNames, unwrap } from "./ast.mjs";

const ITERATION_METHODS = new Set(["map", "flatMap", "forEach"]);

const LOOP_KINDS = Object.freeze({
  ForOfStatement: "a for...of loop",
  ForInStatement: "a for...in loop",
  ForStatement: "a for loop",
});

function isPerItemLoop(node) {
  if (node.type === "ForStatement") {
    // `for (;;)` is a batching or polling loop, broken from inside.
    return node.test !== null;
  }
  return node.type === "ForOfStatement" || node.type === "ForInStatement";
}

/** The array method `fn` is the callback of (`map`, `flatMap` or `forEach`), or `undefined`. */
export function iterationMethod(fn) {
  const call = fn.parent;
  if (call?.type !== "CallExpression" || call.arguments[0] !== fn) {
    return undefined;
  }
  const callee = unwrap(call.callee);
  if (callee.type !== "MemberExpression") {
    return undefined;
  }
  const name = memberName(callee);
  return name !== undefined && ITERATION_METHODS.has(name) ? name : undefined;
}

/**
 * The loop `node` runs in once per item: the body of a `for`, `for...of` or
 * `for...in` loop, or a callback passed to `.map`, `.flatMap` or `.forEach`.
 * Returns `{ node, kind }`, where `node` spans everything bound per
 * iteration (the loop statement, or the callback), or `undefined`.
 *
 * `while` and `do...while` loops and `for` loops without a condition do not
 * count: they are how batched, paged and polling loops are written. The
 * search stops at any other function boundary, since a function defined in
 * a loop does not run there.
 */
export function enclosingLoop(node) {
  let child = node;
  for (let current = node.parent; current !== null && current !== undefined; ) {
    if (isFunction(current)) {
      const method = iterationMethod(current);
      return method === undefined ? undefined : { node: current, kind: `a .${method}() callback` };
    }
    if (isPerItemLoop(current) && current.body === child) {
      return { node: current, kind: LOOP_KINDS[current.type] };
    }
    child = current;
    current = current.parent;
  }
  return undefined;
}

/**
 * The names a loop binds for each item: the variables of a `for...of` or
 * `for...in` head, those a `for` loop declares or assigns in its init, or the
 * parameters of an iteration callback. `loop` is what `enclosingLoop` found.
 */
export function loopBindings(loop) {
  const { node } = loop;
  if (node.type === "ForOfStatement" || node.type === "ForInStatement") {
    return headNames(node.left);
  }
  if (node.type === "ForStatement") {
    return node.init === null ? [] : headNames(node.init);
  }
  return node.params.flatMap((param) => patternNames(param));
}

/** The names a loop head declares (`const x`, `let i = 0, n`) or assigns (`i = 0`). */
function headNames(head) {
  if (head.type === "VariableDeclaration") {
    return head.declarations.flatMap((declarator) => patternNames(declarator.id));
  }
  if (head.type === "AssignmentExpression") {
    return patternNames(head.left);
  }
  if (head.type === "SequenceExpression") {
    return head.expressions.flatMap((expression) => headNames(expression));
  }
  return patternNames(head);
}
