/** @type {import('eslint').Rule.RuleModule} */
export default {
  meta: {
    type: "suggestion",
    docs: {
      description:
        "Warn when defineMethod() is called without a Zod schema option. All user-facing methods should validate payloads.",
    },
    messages: {
      missingSchema:
        "defineMethod('{{ methodName }}') is missing a Zod schema. " +
        "Add { schema: mySchema } as the 4th argument for payload validation.",
    },
    schema: [],
  },
  create(context) {
    return {
      CallExpression(node) {
        const callee = node.callee;
        if (callee.type !== "MemberExpression") return;
        if (callee.property.type !== "Identifier") return;
        if (callee.property.name !== "defineMethod") return;
        if (callee.object.type !== "ThisExpression") return;

        const methodNameArg = node.arguments[0];
        const methodName =
          methodNameArg?.type === "Literal" ? String(methodNameArg.value) : "unknown";

        const optionsArg = node.arguments[3];

        if (!optionsArg) {
          context.report({
            node,
            messageId: "missingSchema",
            data: { methodName },
          });
          return;
        }

        if (optionsArg.type === "ObjectExpression") {
          const hasSchema = optionsArg.properties.some(
            (p) => p.type === "Property" && p.key.type === "Identifier" && p.key.name === "schema",
          );
          if (!hasSchema) {
            context.report({
              node,
              messageId: "missingSchema",
              data: { methodName },
            });
          }
        }
      },
    };
  },
};
