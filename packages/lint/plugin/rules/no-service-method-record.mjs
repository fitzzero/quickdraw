/** @type {import('eslint').Rule.RuleModule} */
export default {
  meta: {
    type: "problem",
    docs: {
      description:
        "Disallow using & ServiceMethodsRecord intersection on BaseService generics. " +
        "This escape hatch defeats type safety by allowing any method name.",
    },
    messages: {
      noServiceMethodRecord:
        "Remove '& ServiceMethodsRecord' from the BaseService generic. " +
        "Use the concrete service methods type directly for full type safety.",
    },
    schema: [],
  },
  create(context) {
    return {
      TSIntersectionType(node) {
        for (const member of node.types) {
          if (
            member.type === "TSTypeReference" &&
            member.typeName?.type === "Identifier" &&
            member.typeName.name === "ServiceMethodsRecord"
          ) {
            context.report({
              node: member,
              messageId: "noServiceMethodRecord",
            });
          }
        }
      },
    };
  },
};
