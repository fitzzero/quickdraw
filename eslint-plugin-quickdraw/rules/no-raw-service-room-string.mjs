/**
 * Bans raw template literals used as room name strings in emit/to/join calls.
 * Use serviceRoom(), userRoom(), etc. helpers from your shared package instead.
 *
 * Options: { additionalPatterns: string[] } — app-specific room patterns
 * (regex sources) checked in addition to the defaults.
 */

const DEFAULT_ROOM_PATTERNS = [/Service:\$\{/, /^user:\$\{/];

/**
 * Check if a template literal node looks like a room string.
 */
function isRoomTemplateLiteral(node, patterns) {
  if (node.type !== "TemplateLiteral" || node.expressions.length === 0) {
    return false;
  }

  // Reconstruct the raw template pattern by replacing expressions with ${...}
  let raw = "";
  for (let i = 0; i < node.quasis.length; i++) {
    raw += node.quasis[i].value.raw;
    if (i < node.expressions.length) {
      raw += "${...}";
    }
  }

  return patterns.some((pattern) => pattern.test(raw));
}

/**
 * Check if a node is a call to emitToRoom, .to(), .join(), or
 * emitConnectedUsers and return the argument index that represents the room name.
 */
function getRoomArgIndex(node) {
  if (node.type !== "CallExpression") return -1;

  const callee = node.callee;

  // this.emitToRoom(ROOM, ...) or service.emitToRoom(ROOM, ...)
  if (
    callee.type === "MemberExpression" &&
    callee.property.type === "Identifier" &&
    callee.property.name === "emitToRoom"
  ) {
    return 0;
  }

  // .to(ROOM) — Socket.IO chaining
  if (
    callee.type === "MemberExpression" &&
    callee.property.type === "Identifier" &&
    callee.property.name === "to"
  ) {
    return 0;
  }

  // .join(ROOM) — Socket.IO room joining
  if (
    callee.type === "MemberExpression" &&
    callee.property.type === "Identifier" &&
    callee.property.name === "join"
  ) {
    return 0;
  }

  // this.emitConnectedUsers(entityId, ROOM)
  if (
    callee.type === "MemberExpression" &&
    callee.property.type === "Identifier" &&
    callee.property.name === "emitConnectedUsers"
  ) {
    return 1;
  }

  return -1;
}

/** @type {import('eslint').Rule.RuleModule} */
export default {
  meta: {
    type: "problem",
    docs: {
      description:
        "Disallow raw template literal room strings in emit/to/join calls. Use serviceRoom() or other room helpers from your shared package.",
    },
    messages: {
      noRawRoomString:
        "Use serviceRoom() or other room helpers from your shared package instead of raw template literals for room names.",
    },
    schema: [
      {
        type: "object",
        properties: {
          additionalPatterns: {
            type: "array",
            items: { type: "string" },
          },
        },
        additionalProperties: false,
      },
    ],
  },
  create(context) {
    const options = context.options[0] ?? {};
    const patterns = [
      ...DEFAULT_ROOM_PATTERNS,
      ...(options.additionalPatterns ?? []).map((source) => new RegExp(source)),
    ];

    return {
      CallExpression(node) {
        const argIndex = getRoomArgIndex(node);
        if (argIndex < 0 || !node.arguments[argIndex]) return;

        const arg = node.arguments[argIndex];
        if (isRoomTemplateLiteral(arg, patterns)) {
          context.report({
            node: arg,
            messageId: "noRawRoomString",
          });
        }
      },
      // Also catch: const room = `chatService:${id}`;
      VariableDeclarator(node) {
        if (
          node.id.type === "Identifier" &&
          /room/i.test(node.id.name) &&
          node.init &&
          isRoomTemplateLiteral(node.init, patterns)
        ) {
          context.report({
            node: node.init,
            messageId: "noRawRoomString",
          });
        }
      },
    };
  },
};
