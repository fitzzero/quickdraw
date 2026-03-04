/** @type {import('eslint').Rule.RuleModule} */
export default {
  meta: {
    type: "suggestion",
    docs: {
      description:
        "Warn on 'as z.infer<typeof ...>' casts in service handlers. " +
        "These are usually unnecessary when types flow correctly from defineMethod.",
    },
    messages: {
      noUnsafePayloadCast:
        "Avoid casting payload with 'as z.infer<typeof ...>'. " +
        "The payload should be properly typed through defineMethod's generic constraint.",
    },
    schema: [],
  },
  create(context) {
    return {
      TSAsExpression(node) {
        const typeAnnotation = node.typeAnnotation
        if (typeAnnotation.type !== "TSTypeReference") return
        if (typeAnnotation.typeName?.type !== "TSQualifiedName") return

        const left = typeAnnotation.typeName.left
        const right = typeAnnotation.typeName.right

        if (
          left.type === "Identifier" &&
          left.name === "z" &&
          right.type === "Identifier" &&
          right.name === "infer"
        ) {
          context.report({
            node,
            messageId: "noUnsafePayloadCast",
          })
        }
      },
    }
  },
}
