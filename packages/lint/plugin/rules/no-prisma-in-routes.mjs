// Route handlers stay thin: database access belongs in service methods,
// which a route reaches in process through `qd.caller(principal)` (RFC 0003
// section 10). This rule reports model calls on the Prisma client in route
// files. Ported from the copies Conveyor, foundation and quickdraw-chat each
// kept; a webhook's writes through the tracked client inside `qd.run` (named
// `db`) are left alone by default.

import { FILE_OPTIONS, ROUTE_FILES, TEST_FILES, inScope } from "../lib/files.mjs";
import { CLIENTS_OPTION, modelCall } from "../lib/prisma.mjs";

const DEFAULT_CLIENTS = ["prisma"];

/** @type {import('eslint').Rule.RuleModule} */
export default {
  meta: {
    type: "problem",
    docs: {
      description:
        "Disallow Prisma calls in route handlers; move database access into a service method.",
    },
    messages: {
      prismaInRoute:
        "`{{ client }}.{{ model }}.{{ method }}()` in a route handler: routes stay thin. " +
        "Move the database access into a service method and call it with `qd.caller(principal)` (a webhook's writes may use the tracked client inside `qd.run(() => ...)`).",
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
    if (!inScope(context, options, { files: ROUTE_FILES, ignore: TEST_FILES })) {
      return {};
    }
    const clients = options.clients ?? DEFAULT_CLIENTS;
    return {
      CallExpression(node) {
        const call = modelCall(node, clients);
        if (call !== undefined) {
          context.report({
            node,
            messageId: "prismaInRoute",
            data: { client: call.client, model: call.model, method: call.method },
          });
        }
      },
    };
  },
};
