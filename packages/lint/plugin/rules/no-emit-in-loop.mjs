// Emitting once per item sends one frame per item to the same room or feed
// where one frame with the whole batch would do (RFC 0003 section 14). This
// rule reports `ctx.rooms.emit`, `ctx.rooms.emitToUser` and a stream's
// `push` inside a per-item loop when the target (the room, the user, the
// stream's scope, or a global stream itself) is the same on every
// iteration. Fan-out, a different target per item, is correct and is not
// reported: a target counts as fixed only when everything it reads is bound
// outside the loop, never reassigned in it, and it calls nothing. A stream's
// batch form is `pushMany(scope, items)`: the items are checked together and
// sent through one room operator, each as the frame `useStream` expects.

import { FILE_OPTIONS, SERVER_FILES, TEST_FILES, inScope } from "../lib/files.mjs";
import { chainNames, contains, memberName, resolveVariable, unwrap, walk } from "../lib/ast.mjs";
import { enclosingLoop } from "../lib/loops.mjs";

const ROOM_METHODS = new Set(["emit", "emitToUser"]);
const DYNAMIC = new Set([
  "AssignmentExpression",
  "AwaitExpression",
  "CallExpression",
  "NewExpression",
  "UpdateExpression",
  "YieldExpression",
]);

/** Whether `node` is a stream handle: `qd.stream(contract, name)`, or a const holding one. */
function isStreamHandle(context, node) {
  const value = unwrap(node);
  if (value.type === "CallExpression") {
    const callee = unwrap(value.callee);
    return callee.type === "MemberExpression" && memberName(callee) === "stream";
  }
  if (value.type !== "Identifier") {
    return false;
  }
  const variable = resolveVariable(context, value);
  const definition = variable?.defs.length === 1 ? variable.defs[0] : undefined;
  return (
    definition?.type === "Variable" &&
    definition.parent?.kind === "const" &&
    definition.node.init !== null &&
    isStreamHandle(context, definition.node.init)
  );
}

/**
 * What an emit sends to: `{ label, what, target }`, where `target` is the
 * argument naming the room, user or stream scope (none for a global stream).
 */
function emitOf(context, call) {
  const callee = unwrap(call.callee);
  if (callee.type !== "MemberExpression") {
    return undefined;
  }
  const names = chainNames(callee);
  if (names.at(-2) === "rooms" && ROOM_METHODS.has(names.at(-1))) {
    return {
      label: names.join("."),
      what: names.at(-1) === "emit" ? "room" : "user",
      target: call.arguments[0],
    };
  }
  if (memberName(callee) === "push" && isStreamHandle(context, callee.object)) {
    const scoped = call.arguments.length >= 2;
    return {
      label: `${context.sourceCode.getText(callee.object)}.push`,
      what: scoped ? "stream scope" : "stream",
      target: scoped ? call.arguments[0] : undefined,
      stream: true,
    };
  }
  return undefined;
}

function isReference(node) {
  const { parent } = node;
  if (parent?.type === "MemberExpression" && parent.property === node && !parent.computed) {
    return false;
  }
  return !(parent?.type === "Property" && parent.key === node && !parent.computed);
}

/** Whether `target` can differ from one iteration of `loop` to the next. */
function varies(context, target, loop) {
  let varying = false;
  walk(context, target, (node) => {
    if (varying) {
      return false;
    }
    if (DYNAMIC.has(node.type)) {
      varying = true;
    } else if (node.type === "Identifier" && isReference(node)) {
      const variable = resolveVariable(context, node);
      varying =
        variable !== null &&
        (variable.defs.some((definition) => contains(loop, definition.name)) ||
          variable.references.some(
            (reference) => reference.isWrite() && contains(loop, reference.identifier),
          ));
    }
    return !varying;
  });
  return varying;
}

/** @type {import('eslint').Rule.RuleModule} */
export default {
  meta: {
    type: "problem",
    docs: {
      description:
        "Disallow emitting to the same room or stream once per item of a loop; send one batched frame.",
    },
    messages: {
      emitInLoop:
        "`{{ emit }}()` inside {{ loop }} sends one frame per item to the same {{ what }}. " +
        "Collect the items and send one frame with all of them after the loop (an array payload).",
      pushInLoop:
        "`{{ emit }}()` inside {{ loop }} pushes one item at a time to the same {{ what }}. " +
        "Collect the items and push them together after the loop with `pushMany` (`pushMany(scope, items)`, or `pushMany(items)` for a global stream).",
    },
    schema: [
      {
        type: "object",
        properties: { ...FILE_OPTIONS },
        additionalProperties: false,
      },
    ],
  },
  create(context) {
    const options = context.options[0] ?? {};
    if (!inScope(context, options, { files: SERVER_FILES, ignore: TEST_FILES })) {
      return {};
    }
    return {
      CallExpression(node) {
        const emit = emitOf(context, node);
        if (emit === undefined) {
          return;
        }
        const loop = enclosingLoop(node);
        if (
          loop === undefined ||
          (emit.target !== undefined && varies(context, emit.target, loop.node))
        ) {
          return;
        }
        context.report({
          node,
          messageId: emit.stream === true ? "pushInLoop" : "emitInLoop",
          data: { emit: emit.label, loop: loop.kind, what: emit.what },
        });
      },
    };
  },
};
