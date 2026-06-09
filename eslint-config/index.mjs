import eslint from "@eslint/js";
import tseslint from "typescript-eslint";
import globals from "globals";
import nextVitals from "eslint-config-next/core-web-vitals";
import quickdrawPlugin from "../eslint-plugin-quickdraw/index.mjs";

export const base = [
  {
    ignores: ["**/dist/", "**/node_modules/", "**/*.js", "**/*.mjs", "**/*.cjs"],
  },
  eslint.configs.recommended,
  ...tseslint.configs.strictTypeChecked,
  ...tseslint.configs.stylisticTypeChecked,
  {
    languageOptions: {
      globals: globals.es2022,
      parserOptions: {
        projectService: true,
      },
    },
    rules: {
      // Type Safety
      "@typescript-eslint/no-explicit-any": "error",
      "@typescript-eslint/no-unsafe-assignment": "error",
      "@typescript-eslint/no-unsafe-call": "error",
      "@typescript-eslint/no-unsafe-member-access": "error",
      "@typescript-eslint/no-unsafe-return": "error",
      "@typescript-eslint/no-unsafe-argument": "error",

      // Promise handling
      "@typescript-eslint/no-floating-promises": "error",
      "@typescript-eslint/no-misused-promises": "error",
      "@typescript-eslint/await-thenable": "error",
      "@typescript-eslint/require-await": "error",

      // Unused code
      "@typescript-eslint/no-unused-vars": [
        "error",
        {
          argsIgnorePattern: "^_",
          varsIgnorePattern: "^_",
          caughtErrorsIgnorePattern: "^_",
        },
      ],

      // Consistency
      "@typescript-eslint/consistent-type-imports": [
        "error",
        { prefer: "type-imports", fixStyle: "inline-type-imports" },
      ],
      "@typescript-eslint/consistent-type-exports": [
        "error",
        { fixMixedExportsWithInlineTypeSpecifier: true },
      ],
      "@typescript-eslint/explicit-function-return-type": [
        "warn",
        {
          allowExpressions: true,
          allowTypedFunctionExpressions: true,
          allowHigherOrderFunctions: true,
          allowDirectConstAssertionInArrowFunctions: true,
        },
      ],
      "@typescript-eslint/naming-convention": [
        "warn",
        { selector: "interface", format: ["PascalCase"] },
        { selector: "typeAlias", format: ["PascalCase"] },
      ],

      // Ban problematic patterns
      "no-restricted-syntax": [
        "error",
        {
          selector: 'TSAsExpression[typeAnnotation.typeName.name="unknown"] > TSAsExpression',
          message:
            "Avoid double `as unknown as` casts. Use proper generics, type guards, or extend the type system.",
        },
      ],

      // Code quality
      "no-console": "warn",
      eqeqeq: ["error", "always", { null: "ignore" }],
      "no-duplicate-imports": "error",
      "prefer-const": "error",
      "no-var": "error",

      // Relaxed
      "@typescript-eslint/no-non-null-assertion": "warn",
      "@typescript-eslint/restrict-template-expressions": "off",
      "@typescript-eslint/no-unnecessary-condition": "off",
    },
  },
];

export const server = [
  ...base,
  {
    languageOptions: {
      globals: globals.node,
    },
    plugins: { quickdraw: quickdrawPlugin },
    rules: {
      "quickdraw/no-cross-service-mutations": "warn",
      "quickdraw/require-zod-schema": "warn",
      "quickdraw/no-service-method-record": "error",
      "quickdraw/no-unsafe-payload-cast": "warn",

      "no-console": "warn",
      "@typescript-eslint/no-misused-promises": [
        "error",
        { checksVoidReturn: { arguments: false } },
      ],

      "@typescript-eslint/no-unsafe-assignment": "warn",
      "@typescript-eslint/no-unsafe-member-access": "warn",
      "@typescript-eslint/no-unsafe-call": "warn",
      "@typescript-eslint/no-unsafe-return": "warn",
      "@typescript-eslint/no-unsafe-argument": "warn",
      "@typescript-eslint/no-redundant-type-constituents": "off",
      "@typescript-eslint/no-unnecessary-type-assertion": "off",
    },
  },
];

export const client = [
  ...nextVitals,
  ...base,
  {
    plugins: { quickdraw: quickdrawPlugin },
    rules: {
      "react/react-in-jsx-scope": "off",
      "react/prop-types": "off",
      "react-hooks/exhaustive-deps": "error",
      "react-hooks/rules-of-hooks": "error",
      "@next/next/no-img-element": "warn",

      "@typescript-eslint/explicit-function-return-type": "off",
      "react/no-unknown-property": "off",

      "@typescript-eslint/no-unsafe-assignment": "warn",
      "@typescript-eslint/no-unsafe-member-access": "warn",
      "@typescript-eslint/no-unsafe-call": "warn",
      "@typescript-eslint/no-unsafe-return": "warn",
      "@typescript-eslint/no-unsafe-argument": "warn",
      "@typescript-eslint/no-redundant-type-constituents": "off",
      "@typescript-eslint/no-unnecessary-type-arguments": "off",

      "quickdraw/no-raw-socket-on": "warn",
      "quickdraw/no-raw-socket-emit": "warn",
    },
  },
];

export const shared = [
  ...base,
  {
    rules: {
      "@typescript-eslint/explicit-function-return-type": "error",
      "@typescript-eslint/explicit-module-boundary-types": "error",
      "no-console": "error",
    },
  },
];
