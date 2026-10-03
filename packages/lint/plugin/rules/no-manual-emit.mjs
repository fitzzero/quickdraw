// Entity frames, collection deltas and change signals are derived from
// tracked writes (RFC 0003 sections 5 to 7); custom events go through the
// contract's `events` and `ctx.rooms.emit`, feeds through streams. This rule
// reports frames sent by hand from server code: `.emit()` (or `.send()`) on
// a chain rooted at the Socket.IO server or a socket (`io.to(room).emit`,
// `socket.broadcast.emit`, `this.io.emit`), and any string starting with
// `qd:`, the framework's own event and room names. `ctx.rooms.emit`,
// `ctx.rooms.emitToUser` and `qd.stream(...).push` are the sanctioned paths
// and are not rooted at a socket.

import { FILE_OPTIONS, SERVER_FILES, TEST_FILES, inScope } from "../lib/files.mjs";
import { chainNames, leadingText, memberName, unwrap } from "../lib/ast.mjs";

const EMIT_METHODS = new Set(["emit", "emitWithAck", "send"]);
const DEFAULT_EMITTERS = ["io", "socket"];
const MODULE_SOURCES = new Set([
  "ImportDeclaration",
  "ExportNamedDeclaration",
  "ExportAllDeclaration",
  "ImportExpression",
  "TSExternalModuleReference",
  "TSImportType",
  "TSLiteralType",
]);

/** Whether a member chain goes through the Socket.IO server or a socket: `io`, `this.io`, `server.io.to(room)`. */
function throughEmitter(names, emitters) {
  return names.some((name) => emitters.includes(name));
}

/** @type {import('eslint').Rule.RuleModule} */
export default {
  meta: {
    type: "problem",
    docs: {
      description:
        "Disallow hand-sent socket frames and `qd:` names in server code: quickdraw derives its frames from tracked writes.",
    },
    messages: {
      manualEmit:
        "`{{ callee }}()` sends a socket frame by hand. Entity frames and collection deltas follow tracked writes (`db.<model>`, or `ctx.touch(model, ids)` for writes the client cannot see); " +
        "custom events are declared in the contract's `events` and sent with `ctx.rooms.emit(room, contract, event, payload)`; feeds use `qd.stream(contract, name).push(...)`.",
      protocolName:
        '"{{ value }}" is a quickdraw protocol name: `qd:` events and rooms belong to the framework. ' +
        "Send app data with `ctx.rooms.emit(room, contract, event, payload)`, a stream, or a tracked write instead.",
    },
    schema: [
      {
        type: "object",
        properties: {
          ...FILE_OPTIONS,
          emitters: {
            type: "array",
            items: { type: "string" },
            description: "Names of the Socket.IO server and sockets.",
          },
        },
        additionalProperties: false,
      },
    ],
  },
  create(context) {
    const options = context.options[0] ?? {};
    if (!inScope(context, options, { files: SERVER_FILES, ignore: TEST_FILES })) {
      return {};
    }
    const emitters = options.emitters ?? DEFAULT_EMITTERS;

    const checkProtocolName = (node) => {
      const text = leadingText(node);
      if (text?.startsWith("qd:") && !MODULE_SOURCES.has(node.parent?.type)) {
        context.report({ node, messageId: "protocolName", data: { value: text } });
      }
    };

    return {
      CallExpression(node) {
        const callee = unwrap(node.callee);
        if (callee.type !== "MemberExpression" || !EMIT_METHODS.has(memberName(callee))) {
          return;
        }
        if (throughEmitter(chainNames(callee.object), emitters)) {
          context.report({
            node,
            messageId: "manualEmit",
            data: { callee: context.sourceCode.getText(callee) },
          });
        }
      },
      Literal: checkProtocolName,
      TemplateLiteral(node) {
        if (node.parent?.type !== "TaggedTemplateExpression") {
          checkProtocolName(node);
        }
      },
    };
  },
};
