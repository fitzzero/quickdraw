// One query per item (N+1) is the most common way a method gets slow as its
// data grows (RFC 0003 section 14). This rule reports an awaited database
// call in the body of a `for`, `for...of` or `for...in` loop, or in a
// `.map`, `.flatMap` or `.forEach` callback. To prefer missing a case over
// flagging correct code it skips `while` loops and `for (;;)` (batched,
// paged and polling loops), `createMany`, and calls that already work on a
// set of rows (an `in:` filter, as in a loop over chunks of ids).

import { FILE_OPTIONS, SERVER_FILES, TEST_FILES, inScope } from "../lib/files.mjs";
import { keyName, walk } from "../lib/ast.mjs";
import { enclosingLoop } from "../lib/loops.mjs";
import { ALL_CLIENTS, CLIENTS_OPTION, modelCall } from "../lib/prisma.mjs";

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
        "Read or write the items in one call (`findMany({ where: { id: { in: ids } } })`, `updateMany`, `createMany`), or send per-row writes together with `db.$transaction([...])`.",
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
        context.report({
          node,
          messageId: "callInLoop",
          data: { client: call.client, model: call.model, method: call.method, loop: loop.kind },
        });
      },
    };
  },
};
