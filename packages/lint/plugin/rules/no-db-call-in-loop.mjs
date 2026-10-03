// One query per item (N+1) is the most common way a method gets slow as its
// data grows (RFC 0003 section 14). This rule reports an awaited database
// call in the body of a `for`, `for...of` or `for...in` loop, or in a
// `.map`, `.flatMap` or `.forEach` callback. To prefer missing a case over
// flagging correct code it skips `while` loops and `for (;;)` (batched,
// paged and polling loops), `createMany`, and calls that already work on a
// set of rows (an `in:` filter, as in a loop over chunks of ids).
//
// Writes through the client of an interactive transaction, inside it
// (`db.$transaction(async (tx) => { for (...) await tx.task.update(...) })`),
// are the sanctioned form of per-row writes whose data differs per row: an
// array-form `$transaction([...])` cannot read the rows a write that moves a
// row or changes who may see it must read first, and `updateMany` sets the
// same data on every row.

import { FILE_OPTIONS, SERVER_FILES, TEST_FILES, inScope } from "../lib/files.mjs";
import { isFunction, keyName, memberName, unwrap, walk } from "../lib/ast.mjs";
import { enclosingLoop } from "../lib/loops.mjs";
import { ALL_CLIENTS, CLIENTS_OPTION, WRITE_METHODS, modelCall } from "../lib/prisma.mjs";

const BATCH_METHODS = new Set(["createMany", "createManyAndReturn"]);

/** Whether a call's arguments filter by a set (`{ in: ids }`). */
function filtersBySet(context, call) {
  let found = false;
  for (const argument of call.args) {
    walk(context, argument, (node) => {
      if (node.type === "Property" && keyName(node) === "in") {
        found = true;
      }
      return !found;
    });
  }
  return found;
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
        "Read the items in one call (`findMany({ where: { id: { in: ids } } })`), write them in one when every row gets the same data (`updateMany`, `createMany`), " +
        "or write each row by id inside an interactive transaction (`db.$transaction(async (tx) => { for (...) await tx.{{ model }}.update(...) })`).",
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
    return {
      AwaitExpression(node) {
        const call = modelCall(node.argument, clients);
        if (call === undefined || BATCH_METHODS.has(call.method) || filtersBySet(context, call)) {
          return;
        }
        const loop = enclosingLoop(node);
        if (loop === undefined) {
          return;
        }
        if (WRITE_METHODS.has(call.method) && inTransactionAround(node, call.client, loop.node)) {
          return;
        }
        context.report({
          node,
          messageId: "callInLoop",
          data: { client: call.client, model: call.model, method: call.method, loop: loop.kind },
        });
      },
    };
  },
};
