// One query per item (N+1) is the most common way a method gets slow as its
// data grows (RFC 0003 section 14). This rule reports an awaited database
// call in the body of a `for`, `for...of` or `for...in` loop, or in a
// `.map`, `.flatMap` or `.forEach` callback, and a database call a `.map` or
// `.flatMap` callback returns when the array goes to `Promise.all` or
// `Promise.allSettled` (all the queries at once is still one per item). To
// prefer missing a case over flagging correct code it skips `while` loops and
// `for (;;)` (batched, paged and polling loops), `createMany`, and calls that
// already work on the loop's own set of rows: an `in:` filter whose value
// names the loop's binding (`for (const chunk of chunks(ids, 500))` with
// `{ id: { in: chunk } }`), or a variable the loop body derives from it.
//
// Writes through the client of an interactive transaction, inside it
// (`db.$transaction(async (tx) => { for (...) await tx.task.update(...) })`),
// are the sanctioned form of per-row writes whose data differs per row: an
// array-form `$transaction([...])` cannot read the rows a write that moves a
// row or changes who may see it must read first, and `updateMany` sets the
// same data on every row.

import { FILE_OPTIONS, SERVER_FILES, TEST_FILES, inScope } from "../lib/files.mjs";
import {
  isFunction,
  keyName,
  memberName,
  mentions,
  patternNames,
  unwrap,
  walk,
} from "../lib/ast.mjs";
import { enclosingLoop, iterationMethod, loopBindings } from "../lib/loops.mjs";
import { ALL_CLIENTS, CLIENTS_OPTION, WRITE_METHODS, modelCall } from "../lib/prisma.mjs";

const ADVICE =
  "Read the items in one call (`findMany({ where: { id: { in: ids } } })`), write them in one when every row gets the same data (`updateMany`, `createMany`), " +
  "or write each row by id inside an interactive transaction (`db.$transaction(async (tx) => { for (...) await tx.{{ model }}.update(...) })`).";

const ALL_METHODS = new Set(["all", "allSettled"]);

const BATCH_METHODS = new Set(["createMany", "createManyAndReturn"]);

/**
 * The names an `in:` filter may use to work on the loop's own set of rows:
 * the loop's bindings, and the variables its body declares from them
 * (`const ids = chunk.map((row) => row.id)`).
 */
function loopNames(context, loop) {
  const bindings = new Set(loopBindings(loop));
  const names = new Set(bindings);
  walk(context, loop.node, (node) => {
    if (
      node.type === "VariableDeclarator" &&
      node.init !== null &&
      mentions(context, node.init, bindings)
    ) {
      for (const name of patternNames(node.id)) {
        names.add(name);
      }
    }
    return true;
  });
  return names;
}

/** Whether a call's arguments filter by the loop's own set (`{ in: chunk }`). */
function filtersByLoopSet(context, call, loop) {
  const names = loopNames(context, loop);
  let found = false;
  for (const argument of call.args) {
    walk(context, argument, (node) => {
      if (
        node.type === "Property" &&
        keyName(node) === "in" &&
        mentions(context, node.value, names)
      ) {
        found = true;
      }
      return !found;
    });
  }
  return found;
}

/** The node `node` is the value of, past parentheses and type assertions. */
function outerOf(node) {
  let current = node;
  while (
    current.parent !== null &&
    current.parent !== undefined &&
    unwrap(current.parent) === unwrap(node)
  ) {
    current = current.parent;
  }
  return current;
}

/** The function `node` is the return value of: an arrow's expression body, or a `return`'s argument. */
function returningFunction(node) {
  const value = outerOf(node);
  const parent = value.parent;
  if (parent?.type === "ArrowFunctionExpression" && parent.body === value) {
    return parent;
  }
  if (parent?.type !== "ReturnStatement") {
    return undefined;
  }
  for (
    let current = parent.parent;
    current !== null && current !== undefined;
    current = current.parent
  ) {
    if (isFunction(current)) {
      return current;
    }
  }
  return undefined;
}

/** Whether `call` (an array method's call) is the argument of `Promise.all` or `Promise.allSettled`. */
function sentToPromiseAll(call) {
  const outer = outerOf(call).parent;
  if (outer?.type !== "CallExpression" || unwrap(outer.arguments[0]) !== call) {
    return false;
  }
  const callee = unwrap(outer.callee);
  return (
    callee.type === "MemberExpression" &&
    unwrap(callee.object).type === "Identifier" &&
    unwrap(callee.object).name === "Promise" &&
    ALL_METHODS.has(memberName(callee))
  );
}

/**
 * The per-item callback a call returns from when its array goes to
 * `Promise.all`: `Promise.all(ids.map((id) => db.task.findUnique(...)))`.
 */
function promiseAllLoop(node) {
  const fn = returningFunction(node);
  const method = fn === undefined ? undefined : iterationMethod(fn);
  if (method !== "map" && method !== "flatMap") {
    return undefined;
  }
  return sentToPromiseAll(fn.parent) ? { node: fn, kind: `a .${method}() callback` } : undefined;
}

/** Whether `fn` is the callback of an interactive transaction: `db.$transaction(async (tx) => ...)`. */
function isTransactionCallback(fn) {
  const call = fn.parent;
  if (call?.type !== "CallExpression" || call.arguments[0] !== fn) {
    return false;
  }
  const callee = unwrap(call.callee);
  return callee.type === "MemberExpression" && memberName(callee) === "$transaction";
}

/**
 * Whether `node`, a write through the client `name`, runs inside the
 * interactive transaction that binds `name`, around `loop`.
 */
function inTransactionAround(node, name, loop) {
  for (let current = node.parent; current !== null && current !== undefined; ) {
    if (isFunction(current) && current.params.some((param) => param.name === name)) {
      let inside = loop;
      while (inside !== null && inside !== undefined && inside !== current) {
        inside = inside.parent;
      }
      return inside === current && isTransactionCallback(current);
    }
    current = current.parent;
  }
  return false;
}

/** @type {import('eslint').Rule.RuleModule} */
export default {
  meta: {
    type: "problem",
    docs: {
      description: "Disallow an awaited database call once per item of a loop (N+1 queries).",
    },
    messages: {
      callInLoop:
        "`await {{ client }}.{{ model }}.{{ method }}()` inside {{ loop }} runs one query per item. " +
        ADVICE,
      callPerItem:
        "`{{ client }}.{{ model }}.{{ method }}()` returned from {{ loop }} whose results go to `Promise.all` runs one query per item, all at once. " +
        ADVICE,
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
    /** Whether a call in `loop` is not one query per item after all. */
    const exempt = (node, call, loop) =>
      BATCH_METHODS.has(call.method) ||
      filtersByLoopSet(context, call, loop) ||
      (WRITE_METHODS.has(call.method) && inTransactionAround(node, call.client, loop.node));
    const report = (node, messageId, call, loop) =>
      context.report({
        node,
        messageId,
        data: { client: call.client, model: call.model, method: call.method, loop: loop.kind },
      });
    return {
      AwaitExpression(node) {
        const call = modelCall(node.argument, clients);
        const loop = call === undefined ? undefined : enclosingLoop(node);
        if (loop !== undefined && !exempt(node, call, loop)) {
          report(node, "callInLoop", call, loop);
        }
      },
      CallExpression(node) {
        // An awaited call is the AwaitExpression's to report.
        if (outerOf(node).parent?.type === "AwaitExpression") {
          return;
        }
        const call = modelCall(node, clients);
        const loop = call === undefined ? undefined : promiseAllLoop(node);
        if (loop !== undefined && !exempt(node, call, loop)) {
          report(node, "callPerItem", call, loop);
        }
      },
    };
  },
};
