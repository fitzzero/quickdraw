/**
 * Allowed event name prefixes that are exempt from this rule.
 * These are documented exceptions for protocols that don't map to BaseService.
 */
const DEFAULT_ALLOWED_PREFIXES = ["agentRunner:", "projectRunner:"]

/** @type {import('eslint').Rule.RuleModule} */
export default {
  meta: {
    type: "problem",
    docs: {
      description:
        "Disallow raw socket.on() in components. " +
        "Use useRoomEvents() for custom event listeners or useSubscription() for entity updates.",
    },
    messages: {
      noRawSocketOn:
        "Avoid raw socket.on('{{ eventName }}'). " +
        "Use useRoomEvents({ '{{ eventName }}': handler }) for lifecycle-managed event listeners, " +
        "or useSubscription() for entity data.",
      noRawSocketOnDynamic:
        "Avoid raw socket.on() with dynamic event names. " +
        "Use useRoomEvents() for lifecycle-managed event listeners.",
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
        },
        additionalProperties: false,
      },
    ],
  },
  create(context) {
    const options = context.options[0] || {}
    const allowedPrefixes = options.allowedPrefixes || DEFAULT_ALLOWED_PREFIXES

    return {
      CallExpression(node) {
        const callee = node.callee
        if (callee.type !== "MemberExpression") return
        if (callee.property.type !== "Identifier") return
        if (callee.property.name !== "on") return

        const obj = callee.object
        if (obj.type !== "Identifier" || obj.name !== "socket") return

        const eventArg = node.arguments[0]
        if (!eventArg) return

        if (eventArg.type === "Literal" && typeof eventArg.value === "string") {
          const eventName = eventArg.value

          if (allowedPrefixes.some((prefix) => eventName.startsWith(prefix))) {
            return
          }

          context.report({
            node,
            messageId: "noRawSocketOn",
            data: { eventName },
          })
        } else {
          context.report({
            node,
            messageId: "noRawSocketOnDynamic",
          })
        }
      },
    }
  },
}
