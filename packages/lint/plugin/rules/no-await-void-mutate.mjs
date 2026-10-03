// `qd.<service>.<method>.useMutation()` returns TanStack Query's mutation:
// `mutate()` returns nothing and reports failure through `onError`; only
// `mutateAsync()` returns a promise. Awaiting `mutate()` therefore resolves
// before the server answers, so the code after it runs before the write
// happened, and it cannot catch the write's failure. Ported from Conveyor's
// `no-await-void-mutate`.

import { FILE_OPTIONS, CLIENT_FILES, inScope } from "../lib/files.mjs";
import { memberName, unwrap } from "../lib/ast.mjs";

/** @type {import('eslint').Rule.RuleModule} */
export default {
  meta: {
    type: "problem",
    docs: {
      description:
        "Disallow `await x.mutate()`: `mutate()` returns nothing; await `mutateAsync()` instead.",
    },
    messages: {
      awaitMutate:
        "`mutate()` returns nothing: awaiting it resolves before the server answers, so the code after it runs before the write happened and cannot catch its failure. " +
        "Use `await mutation.mutateAsync(input)` and handle the rejection, or pass `onSuccess`/`onError` to `mutate`.",
    },
    schema: [
      {
        type: "object",
        properties: { ...FILE_OPTIONS },
        additionalProperties: false,
      },
    ],
  },
  create(context) {
    if (!inScope(context, context.options[0] ?? {}, { files: CLIENT_FILES })) {
      return {};
    }
    return {
      AwaitExpression(node) {
        const call = unwrap(node.argument);
        if (call?.type !== "CallExpression") {
          return;
        }
        const callee = unwrap(call.callee);
        if (
          callee.type === "MemberExpression" &&
          !callee.computed &&
          memberName(callee) === "mutate"
        ) {
          context.report({ node, messageId: "awaitMutate" });
        }
      },
    };
  },
};
