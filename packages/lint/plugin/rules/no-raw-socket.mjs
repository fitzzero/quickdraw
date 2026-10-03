// Client code talks to the server through the typed client and its live
// hooks (RFC 0003 section 11), which validate, authorize, track revisions and
// survive reconnects. This rule reports raw Socket.IO calls in client code:
// `socket.emit`, `socket.on`, `socket.once`, `socket.off` and the `*Any`
// listeners, on a socket named `socket` or a member ending in it
// (`connection.socket`). It replaces 4.1's `no-raw-socket-emit` and
// `no-raw-socket-on`; their app-specific default exemptions are gone, and
// `allowedEvents`/`allowedPrefixes` take an app's own.

import { CLIENT_FILES, FILE_OPTIONS, TEST_FILES, inScope } from "../lib/files.mjs";
import { chainNames, memberName, staticString, unwrap } from "../lib/ast.mjs";

const METHODS = new Set([
  "emit",
  "emitWithAck",
  "send",
  "on",
  "once",
  "off",
  "onAny",
  "prependAny",
  "offAny",
  "onAnyOutgoing",
  "prependAnyOutgoing",
  "offAnyOutgoing",
]);

/** @type {import('eslint').Rule.RuleModule} */
export default {
  meta: {
    type: "problem",
    docs: {
      description:
        "Disallow raw Socket.IO calls in client code; use the typed client and its hooks.",
    },
    messages: {
      rawSocket:
        "Raw `socket.{{ method }}()` bypasses the typed client: no input or access checks on the way, no revisions, no reconnect handling. " +
        "Call methods through `qd.<service>.<method>` (`useQuery`, `useMutation`, `call`), read live data with `useEntity`, `useCollection`, `useStream` or `useEvent`, send with `useChannel`, and read the connection's state with `useQuickdraw()`.",
    },
    schema: [
      {
        type: "object",
        properties: {
          ...FILE_OPTIONS,
          sockets: {
            type: "array",
            items: { type: "string" },
            description: "Names a socket goes by.",
          },
          allowedEvents: {
            type: "array",
            items: { type: "string" },
            description: "Event names that may be used raw.",
          },
          allowedPrefixes: {
            type: "array",
            items: { type: "string" },
            description: "Event name prefixes that may be used raw.",
          },
        },
        additionalProperties: false,
      },
    ],
  },
  create(context) {
    const options = context.options[0] ?? {};
    if (!inScope(context, options, { files: CLIENT_FILES, ignore: TEST_FILES })) {
      return {};
    }
    const sockets = options.sockets ?? ["socket"];
    const allowedEvents = new Set(options.allowedEvents ?? []);
    const allowedPrefixes = options.allowedPrefixes ?? [];

    return {
      CallExpression(node) {
        const callee = unwrap(node.callee);
        const method = callee.type === "MemberExpression" ? memberName(callee) : undefined;
        if (method === undefined || !METHODS.has(method)) {
          return;
        }
        if (!chainNames(callee.object).some((name) => sockets.includes(name))) {
          return;
        }
        const event = node.arguments[0] === undefined ? undefined : staticString(node.arguments[0]);
        if (
          event !== undefined &&
          (allowedEvents.has(event) || allowedPrefixes.some((prefix) => event.startsWith(prefix)))
        ) {
          return;
        }
        context.report({ node, messageId: "rawSocket", data: { method } });
      },
    };
  },
};
