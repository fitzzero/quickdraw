/** @type {import('eslint').Rule.RuleModule} */
export default {
  meta: {
    type: "problem",
    docs: {
      description:
        "Disallow direct Prisma create/update/delete in service methods. Use this.create(), this.update(), this.delete() instead for proper event emission.",
    },
    messages: {
      noDirectMutation:
        "Use this.{{ method }}() from BaseService instead of this.prisma.{{ model }}.{{ method }}(). " +
        "BaseService methods auto-emit updates to subscribers.",
    },
    schema: [],
  },
  create(context) {
    const MUTATION_METHODS = new Set(["create", "update", "delete"]);

    return {
      CallExpression(node) {
        const callee = node.callee;
        if (callee.type !== "MemberExpression") return;
        if (callee.property.type !== "Identifier") return;

        const methodName = callee.property.name;
        if (!MUTATION_METHODS.has(methodName)) return;

        const obj = callee.object;
        if (obj.type !== "MemberExpression") return;

        const parentObj = obj.object;
        if (parentObj.type !== "MemberExpression") return;
        if (parentObj.property.type !== "Identifier") return;
        if (parentObj.property.name !== "prisma") return;

        if (parentObj.object.type !== "ThisExpression") return;

        const modelName = obj.property.type === "Identifier" ? obj.property.name : "model";

        context.report({
          node,
          messageId: "noDirectMutation",
          data: { method: methodName, model: modelName },
        });
      },
    };
  },
};
