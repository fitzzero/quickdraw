// A `findMany` without `take` in a service reads every matching row, and the
// table only grows (RFC 0003 section 14). Not reported: a read whose
// arguments are not written out literally or spread another object (its
// `take` may come from there), and a read that names its ids: `id` equal to
// a value, `{ in: ids }` or `{ equals: id }`. `{ not }`, `{ notIn }` and the
// comparisons (`gt`, `lt`, ...) leave every other row, so they do not bound
// it.

import { FILE_OPTIONS, SERVICE_FILES, TEST_FILES, inScope } from "../lib/files.mjs";
import { getProperty, hasSpread, unwrap } from "../lib/ast.mjs";
import { ALL_CLIENTS, CLIENTS_OPTION, modelCall } from "../lib/prisma.mjs";

/**
 * Whether an `id` filter names the rows it reads: a value (equality), or a
 * filter object with `in` or `equals`. A filter object built elsewhere
 * cannot be judged, so it counts as naming them.
 */
function namesIds(value) {
  const filter = unwrap(value);
  if (filter.type !== "ObjectExpression" || hasSpread(filter)) {
    return true;
  }
  return getProperty(filter, "in") !== undefined || getProperty(filter, "equals") !== undefined;
}

/** Whether `findMany`'s argument bounds the read or cannot be judged. */
function isBounded(argument) {
  const options = unwrap(argument);
  if (options.type !== "ObjectExpression" || hasSpread(options)) {
    return true;
  }
  if (getProperty(options, "take") !== undefined) {
    return true;
  }
  const where = getProperty(options, "where");
  const filter = where === undefined ? undefined : unwrap(where.value);
  const id = filter?.type === "ObjectExpression" ? getProperty(filter, "id") : undefined;
  return id !== undefined && namesIds(id.value);
}

/** @type {import('eslint').Rule.RuleModule} */
export default {
  meta: {
    type: "problem",
    docs: {
      description:
        "Require `take` on `findMany` in services, so a read cannot grow with the table.",
    },
    messages: {
      unbounded:
        "`{{ client }}.{{ model }}.findMany()` without `take` reads every matching row, however many there are. " +
        "Add `take` (with a `cursor` to page), or serve the list as a collection (`useCollection` pages it and keeps it live) or the read/write kit's `list`.",
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
    if (!inScope(context, options, { files: SERVICE_FILES, ignore: TEST_FILES })) {
      return {};
    }
    const clients = options.clients ?? ALL_CLIENTS;
    return {
      CallExpression(node) {
        const call = modelCall(node, clients);
        if (call?.method !== "findMany") {
          return;
        }
        if (call.args.length > 0 && isBounded(call.args[0])) {
          return;
        }
        context.report({
          node,
          messageId: "unbounded",
          data: { client: call.client, model: call.model },
        });
      },
    };
  },
};
