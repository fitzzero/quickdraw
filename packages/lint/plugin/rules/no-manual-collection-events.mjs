/**
 * Flags emitToRoom calls whose event name is row-list compensation —
 * `*:created` / `*:deleted` / `*:updated` / `*:reordered` — the hand-wired
 * stack that collection subscriptions (defineCollection + useCollection)
 * replace with automatic, multi-node-safe deltas.
 *
 * Ship at "warn" while migrating; flip to "error" once collections cover
 * the events. emitToRoomVolatile is deliberately not flagged — volatile
 * emits are for ephemeral state, which is correctly not a collection.
 */

const COMPENSATION_EVENT = /:(created|deleted|updated|reordered)$/;

/**
 * Extract the static tail of an event-name argument: the whole string for
 * a literal, the last quasi for a template literal (`${service}:created`).
 */
function staticEventTail(node) {
  if (node.type === "Literal" && typeof node.value === "string") {
    return node.value;
  }
  if (node.type === "TemplateLiteral" && node.quasis.length > 0) {
    return node.quasis[node.quasis.length - 1].value.cooked ?? "";
  }
  return null;
}

/** @type {import('eslint').Rule.RuleModule} */
export default {
  meta: {
    type: "suggestion",
    docs: {
      description:
        "Disallow hand-emitted row add/remove/update events via emitToRoom. Declare a collection instead — defineCollection emits added/updated/removed deltas automatically (multi-node-safe, with reconnect re-snapshot).",
    },
    messages: {
      declareCollection:
        'Hand-emitted "{{ eventName }}" is row-list compensation. Declare a collection instead: defineCollection() emits added/updated/removed deltas automatically, and useCollection() replaces the client-side merge.',
    },
    schema: [],
  },
  create(context) {
    return {
      CallExpression(node) {
        const callee = node.callee;
        if (
          callee.type !== "MemberExpression" ||
          callee.property.type !== "Identifier" ||
          callee.property.name !== "emitToRoom"
        ) {
          return;
        }

        const eventArg = node.arguments[1];
        if (!eventArg) return;

        const tail = staticEventTail(eventArg);
        if (tail !== null && COMPENSATION_EVENT.test(tail)) {
          context.report({
            node: eventArg,
            messageId: "declareCollection",
            data: { eventName: tail },
          });
        }
      },
    };
  },
};
