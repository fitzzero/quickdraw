// A quickdraw mutation's tracked writes already update the live data that
// shows its rows, and the invalidation coordinator refetches the queries
// that `watch` them, one read in flight per key (RFC 0003 section 11.3).
// This rule reports the hand-written versions:
// - a quickdraw query's `refetch()` in the statement right after an awaited
//   quickdraw `mutateAsync(...)`, or in a quickdraw mutation's `onSuccess`
//   or `onSettled`;
// - `invalidateQueries`, `refetchQueries` or `resetQueries` on a quickdraw
//   key (`["qd", ...]`, a key helper, or `qd.<service>.<method>.key(...)`),
//   which bypasses the coordinator: use `qd.invalidate(...)`.
// Queries and mutations are quickdraw's when they come from
// `qd.<service>.<member>.useQuery`/`useMutation` in the same file.

import { CLIENT_FILE_OPTIONS, inClientScope } from "../lib/files.mjs";
import {
  chainNames,
  getProperty,
  isFunction,
  memberName,
  resolveVariable,
  staticString,
  unwrap,
  walk,
} from "../lib/ast.mjs";

const QUERY_HOOKS = new Set(["useQuery", "useSuspenseQuery", "useInfiniteQuery"]);
const MUTATION_HOOKS = new Set(["useMutation"]);
const MUTATE_METHODS = new Set(["mutate", "mutateAsync"]);
const CACHE_METHODS = new Set(["invalidateQueries", "refetchQueries", "resetQueries"]);
const KEY_HELPERS = new Set([
  "KEY_ROOT",
  "collectionKey",
  "entityKey",
  "methodKey",
  "methodKeyPrefix",
  "serviceKeyPrefix",
]);
const QUICKDRAW = /^@fitzzero\/quickdraw-core(?:\/client|\/utils)?$/;

/** @type {import('eslint').Rule.RuleModule} */
export default {
  meta: {
    type: "problem",
    docs: {
      description:
        "Disallow refetching quickdraw queries by hand after a mutation, and invalidating quickdraw keys outside `qd.invalidate`.",
    },
    messages: {
      refetchAfterMutation:
        "Refetching right after a mutation reads twice and can race the mutation's own update: its tracked writes already update entity and collection subscribers, and queries that `watch` the changed scope are invalidated through the coordinator. " +
        "Remove the `refetch()`; if this query must follow these writes, give it a `watch` in its contract.",
      invalidateKey:
        "`{{ method }}` on a quickdraw key bypasses the invalidation coordinator, which keeps one read in flight per key. " +
        "Use `qd.invalidate(member, input?)` or `qd.invalidate(key)` instead.",
    },
    schema: [
      {
        type: "object",
        properties: {
          ...CLIENT_FILE_OPTIONS,
          clients: {
            type: "array",
            items: { type: "string" },
            description: "Names of the typed client from `createQuickdrawClient`.",
          },
        },
        additionalProperties: false,
      },
    ],
  },
  create(context) {
    const options = context.options[0] ?? {};
    if (!inClientScope(context, options)) {
      return {};
    }
    const clients = new Set(options.clients ?? ["qd"]);
    const keyHelpers = new Set();

    /** Whether `node` calls one of the typed client's `hooks`: `qd.task.get.useQuery(...)`. */
    const isHookCall = (node, hooks) => {
      const call = unwrap(node);
      if (call?.type !== "CallExpression") {
        return false;
      }
      const names = chainNames(call.callee);
      return clients.has(names[0]) && hooks.has(names.at(-1));
    };

    /** Whether `node` is (or names a variable declared from) a call to one of `hooks`. */
    const fromHook = (node, hooks) => {
      const value = unwrap(node);
      if (isHookCall(value, hooks)) {
        return true;
      }
      if (value?.type !== "Identifier") {
        return false;
      }
      const definition = resolveVariable(context, value)?.defs[0];
      return (
        definition?.type === "Variable" &&
        definition.node.init !== null &&
        isHookCall(definition.node.init, hooks)
      );
    };

    /** The `refetch()` call of a quickdraw query in `expression`, if it is one. */
    const quickdrawRefetch = (expression) => {
      let call = unwrap(expression);
      if (call?.type === "AwaitExpression") {
        call = unwrap(call.argument);
      }
      if (call?.type !== "CallExpression") {
        return undefined;
      }
      const callee = unwrap(call.callee);
      if (callee.type === "Identifier" && callee.name === "refetch") {
        return fromHook(callee, QUERY_HOOKS) ? call : undefined;
      }
      if (callee.type === "MemberExpression" && memberName(callee) === "refetch") {
        return fromHook(callee.object, QUERY_HOOKS) ? call : undefined;
      }
      return undefined;
    };

    /** Whether a statement awaits a quickdraw mutation's `mutateAsync(...)`. */
    const awaitsMutation = (statement) => {
      let expressions = [];
      if (statement.type === "ExpressionStatement") {
        expressions = [statement.expression];
      } else if (statement.type === "VariableDeclaration") {
        expressions = statement.declarations.map((declarator) => declarator.init);
      }
      return expressions.some((expression) => {
        const awaited = unwrap(expression);
        if (awaited?.type !== "AwaitExpression") {
          return false;
        }
        const call = unwrap(awaited.argument);
        const callee = call?.type === "CallExpression" ? unwrap(call.callee) : undefined;
        return (
          callee?.type === "MemberExpression" &&
          memberName(callee) === "mutateAsync" &&
          fromHook(callee.object, MUTATION_HOOKS)
        );
      });
    };

    const checkStatements = (statements) => {
      for (let index = 1; index < statements.length; index += 1) {
        const next = statements[index];
        if (next.type === "ExpressionStatement" && awaitsMutation(statements[index - 1])) {
          const refetch = quickdrawRefetch(next.expression);
          if (refetch !== undefined) {
            context.report({ node: refetch, messageId: "refetchAfterMutation" });
          }
        }
      }
    };

    /** Whether a call takes mutation callbacks: a quickdraw `useMutation(...)` or a quickdraw mutation's `mutate(...)`. */
    const takesMutationCallbacks = (call) => {
      if (isHookCall(call, MUTATION_HOOKS)) {
        return true;
      }
      const callee = unwrap(call.callee);
      return (
        callee.type === "MemberExpression" &&
        MUTATE_METHODS.has(memberName(callee)) &&
        fromHook(callee.object, MUTATION_HOOKS)
      );
    };

    const checkCallbacks = (call) => {
      for (const argument of call.arguments) {
        const object = unwrap(argument);
        if (object.type !== "ObjectExpression") {
          continue;
        }
        for (const name of ["onSuccess", "onSettled"]) {
          const callback = getProperty(object, name);
          if (callback === undefined || !isFunction(unwrap(callback.value))) {
            continue;
          }
          walk(context, callback.value, (node) => {
            const refetch = node.type === "CallExpression" ? quickdrawRefetch(node) : undefined;
            if (refetch !== undefined) {
              context.report({ node: refetch, messageId: "refetchAfterMutation" });
            }
          });
        }
      }
    };

    const isQuickdrawKey = (value) => {
      const node = unwrap(value);
      if (node.type === "ArrayExpression") {
        const first =
          node.elements[0] === null || node.elements[0] === undefined
            ? undefined
            : unwrap(node.elements[0]);
        return (
          first !== undefined &&
          (staticString(first) === "qd" ||
            (first.type === "Identifier" && keyHelpers.has(first.name)))
        );
      }
      if (node.type !== "CallExpression") {
        return false;
      }
      const callee = unwrap(node.callee);
      if (callee.type === "Identifier") {
        return keyHelpers.has(callee.name);
      }
      const names = chainNames(callee);
      return clients.has(names[0]) && names.at(-1) === "key";
    };

    const keyOf = (filter) => {
      const node = filter === undefined ? undefined : unwrap(filter);
      if (node?.type === "ObjectExpression") {
        return getProperty(node, "queryKey")?.value;
      }
      return node;
    };

    return {
      ImportDeclaration(node) {
        if (!QUICKDRAW.test(node.source.value)) {
          return;
        }
        for (const specifier of node.specifiers) {
          if (specifier.type === "ImportSpecifier") {
            const name =
              specifier.imported.type === "Identifier"
                ? specifier.imported.name
                : specifier.imported.value;
            if (KEY_HELPERS.has(name)) {
              keyHelpers.add(specifier.local.name);
            }
          }
        }
      },
      Program(node) {
        checkStatements(node.body);
      },
      BlockStatement(node) {
        checkStatements(node.body);
      },
      CallExpression(node) {
        if (takesMutationCallbacks(node)) {
          checkCallbacks(node);
          return;
        }
        const callee = unwrap(node.callee);
        const method = callee.type === "MemberExpression" ? memberName(callee) : undefined;
        const key = CACHE_METHODS.has(method) ? keyOf(node.arguments[0]) : undefined;
        if (key !== undefined && isQuickdrawKey(key)) {
          context.report({ node, messageId: "invalidateKey", data: { method } });
        }
      },
    };
  },
};
