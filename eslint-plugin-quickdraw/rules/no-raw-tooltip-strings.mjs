/** @type {import('eslint').Rule.RuleModule} */
export default {
  meta: {
    type: "problem",
    docs: {
      description:
        "Disallow raw string literals in Tooltip title props. Use useTranslations() for localization.",
    },
    messages: {
      noRawTooltipStrings:
        "Raw string '{{content}}' in Tooltip title should be localized. Use t('key') instead.",
    },
    schema: [],
  },
  create(context) {
    return {
      JSXOpeningElement(node) {
        if (node.name.type !== "JSXIdentifier" || node.name.name !== "Tooltip") {
          return;
        }

        const titleAttr = node.attributes.find(
          (a) => a.type === "JSXAttribute" && a.name.name === "title",
        );
        if (!titleAttr) return;

        // Check for title="raw string"
        if (
          titleAttr.value &&
          (titleAttr.value.type === "StringLiteral" || titleAttr.value.type === "Literal") &&
          typeof titleAttr.value.value === "string" &&
          titleAttr.value.value.trim().length > 0
        ) {
          context.report({
            node: titleAttr,
            messageId: "noRawTooltipStrings",
            data: { content: titleAttr.value.value },
          });
        }

        // Check for title={"raw string"}
        if (
          titleAttr.value &&
          titleAttr.value.type === "JSXExpressionContainer" &&
          titleAttr.value.expression &&
          titleAttr.value.expression.type === "Literal" &&
          typeof titleAttr.value.expression.value === "string" &&
          titleAttr.value.expression.value.trim().length > 0
        ) {
          context.report({
            node: titleAttr,
            messageId: "noRawTooltipStrings",
            data: { content: titleAttr.value.expression.value },
          });
        }
      },
    };
  },
};
