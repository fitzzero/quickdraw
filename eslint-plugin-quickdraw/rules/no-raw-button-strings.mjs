/** @type {import('eslint').Rule.RuleModule} */
export default {
  meta: {
    type: "problem",
    docs: {
      description:
        "Disallow raw string literals in Button components. Use useTranslations() or the <T> component for localization.",
    },
    messages: {
      noRawButtonStrings:
        "Raw string '{{content}}' in Button component should be localized. Use t('key') or <T>key</T> instead.",
    },
    schema: [],
  },
  create(context) {
    return {
      JSXElement(node) {
        // Check if this is a Button element
        if (
          node.openingElement.name.type !== "JSXIdentifier" ||
          node.openingElement.name.name !== "Button"
        ) {
          return;
        }

        // Check all children for raw strings
        for (const child of node.children) {
          if (child.type === "JSXText") {
            // Flag JSXText that contains non-whitespace characters
            const trimmedText = child.value.trim();
            if (trimmedText.length > 0) {
              context.report({
                node: child,
                messageId: "noRawButtonStrings",
                data: { content: trimmedText },
              });
            }
          } else if (child.type === "JSXExpressionContainer") {
            // Flag JSXExpressionContainer where the expression is a string literal
            if (child.expression.type === "Literal" && typeof child.expression.value === "string") {
              context.report({
                node: child,
                messageId: "noRawButtonStrings",
                data: { content: child.expression.value },
              });
            }
          }
        }
      },
    };
  },
};
