/**
 * Allowed event name prefixes that are exempt from this rule.
 * These are documented exceptions for protocols that don't map to BaseService.
 */
const DEFAULT_ALLOWED_PREFIXES = ["agentRunner:", "projectRunner:"];

/**
 * Allowed exact event names that are exempt from this rule.
 */
const DEFAULT_ALLOWED_EVENTS = new Set(["subscribe", "unsubscribe"]);

/** @type {import('eslint').Rule.RuleModule} */
export default {
  meta: {
    type: "problem",
    docs: {
      description:
        "Disallow raw socket.emit() in components. " +
        "Use useService() for mutations, useServiceQuery() for reads, " +
        "or useSubscription() for entity subscriptions.",
    },
    messages: {
      noRawSocketEmit:
        "Avoid raw socket.emit('{{ eventName }}'). " +
        "Use useService() for mutations or useServiceQuery() for reads.",
      noRawSocketEmitDynamic:
        "Avoid raw socket.emit() with dynamic event names. " +
        "Use useService() for mutations or useServiceQuery() for reads.",
    },
    schema: [
      {
        type: "object",
        properties: {
          allowedPrefixes: {
            type: "array",
            items: { type: "string" },
            description:
              "Event name prefixes that are exempt from this rule " +
              '(e.g. ["agentRunner:", "projectRunner:"])',
          },
          allowedEvents: {
            type: "array",
            items: { type: "string" },
            description:
              "Exact event names that are exempt from this rule " +
              '(e.g. ["subscribe", "unsubscribe"])',
          },
        },
        additionalProperties: false,
      },
    ],
  },
  create(context) {
    const options = context.options[0] || {};
    const allowedPrefixes = options.allowedPrefixes || DEFAULT_ALLOWED_PREFIXES;
    const allowedEvents = new Set(options.allowedEvents || DEFAULT_ALLOWED_EVENTS);

    return {
      CallExpression(node) {
        const callee = node.callee;
        if (callee.type !== "MemberExpression") return;
        if (callee.property.type !== "Identifier") return;
        if (callee.property.name !== "emit") return;

        const obj = callee.object;
        if (obj.type !== "Identifier" || obj.name !== "socket") return;

        const eventArg = node.arguments[0];
        if (!eventArg) return;

        if (eventArg.type === "Literal" && typeof eventArg.value === "string") {
          const eventName = eventArg.value;

          if (allowedEvents.has(eventName)) return;
          if (allowedPrefixes.some((prefix) => eventName.startsWith(prefix))) {
            return;
          }

          context.report({
            node,
            messageId: "noRawSocketEmit",
            data: { eventName },
          });
        } else {
          context.report({
            node,
            messageId: "noRawSocketEmitDynamic",
          });
        }
      },
    };
  },
};
