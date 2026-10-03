// Server data goes through the typed client: `qd.<service>.<method>.useQuery`
// and `.useMutation` share the client's keys, not-modified answers,
// invalidation coordinator and optimistic overlays (RFC 0003 section 11).
// TanStack Query used directly for other data is fine. This rule reports a
// TanStack hook imported from `@tanstack/react-query` whose `queryFn` or
// `mutationFn` reaches quickdraw by hand (a call on the typed client, such
// as `qd.task.get.call(input)`; the `call`/`callData` helpers; a `fetch` of
// `/qd/...`; a raw socket emit), or whose `queryKey` is a quickdraw key.

import { CLIENT_FILE_OPTIONS, inClientScope } from "../lib/files.mjs";
import {
  chainNames,
  keyName,
  leadingText,
  memberName,
  staticString,
  unwrap,
  walk,
} from "../lib/ast.mjs";

const TANSTACK = "@tanstack/react-query";
const QUICKDRAW = /^@fitzzero\/quickdraw-core(?:\/client|\/utils)?$/;
const HOOKS = new Set([
  "useQuery",
  "useSuspenseQuery",
  "useInfiniteQuery",
  "useSuspenseInfiniteQuery",
  "useQueries",
  "useSuspenseQueries",
  "useMutation",
  "usePrefetchQuery",
  "usePrefetchInfiniteQuery",
  "queryOptions",
  "infiniteQueryOptions",
  "mutationOptions",
]);
const HELPERS = new Set([
  "call",
  "callData",
  "methodKey",
  "methodKeyPrefix",
  "serviceKeyPrefix",
  "entityKey",
  "collectionKey",
  "KEY_ROOT",
]);
const SOCKET_EMITS = new Set(["emit", "emitWithAck"]);

function importedName(specifier) {
  return specifier.imported.type === "Identifier"
    ? specifier.imported.name
    : specifier.imported.value;
}

/** @type {import('eslint').Rule.RuleModule} */
export default {
  meta: {
    type: "problem",
    docs: {
      description:
        "Disallow TanStack Query hooks that fetch quickdraw data by hand; use the typed client's hooks.",
    },
    messages: {
      untypedClient:
        "`{{ hook }}` from @tanstack/react-query fetches quickdraw data by hand, outside the typed client: it gets no live updates, not-modified answers, invalidation coordinator or optimistic overlays. " +
        "Use the method's own hook: `qd.<service>.<method>.useQuery(input)` or `.useMutation()`.",
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
    const hooks = new Map();
    const namespaces = new Set();
    const helpers = new Set();

    const hookOf = (callee) => {
      const node = unwrap(callee);
      if (node.type === "Identifier") {
        return hooks.get(node.name);
      }
      if (node.type === "MemberExpression" && namespaces.has(unwrap(node.object).name)) {
        const name = memberName(node);
        return HOOKS.has(name) ? name : undefined;
      }
      return undefined;
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
          (staticString(first) === "qd" || (first.type === "Identifier" && helpers.has(first.name)))
        );
      }
      if (node.type !== "CallExpression") {
        return false;
      }
      const callee = unwrap(node.callee);
      return (
        (callee.type === "Identifier" && helpers.has(callee.name)) ||
        (callee.type === "MemberExpression" && clients.has(chainNames(callee)[0]))
      );
    };

    const reachesQuickdraw = (call) => {
      const callee = unwrap(call.callee);
      if (callee.type === "Identifier") {
        return (
          helpers.has(callee.name) ||
          (callee.name === "fetch" && (leadingText(call.arguments[0]) ?? "").includes("/qd/"))
        );
      }
      if (callee.type !== "MemberExpression") {
        return false;
      }
      const names = chainNames(callee);
      return clients.has(names[0]) || (SOCKET_EMITS.has(names.at(-1)) && names.includes("socket"));
    };

    const fetchesByHand = (argument) => {
      let found = false;
      walk(context, argument, (node) => {
        if (found || node.type !== "Property") {
          return !found;
        }
        const name = keyName(node);
        if (name === "queryKey") {
          found = isQuickdrawKey(node.value);
        } else if (name === "queryFn" || name === "mutationFn") {
          walk(context, node.value, (inner) => {
            if (!found && inner.type === "CallExpression" && reachesQuickdraw(inner)) {
              found = true;
            }
            return !found;
          });
        }
        return !found;
      });
      return found;
    };

    return {
      ImportDeclaration(node) {
        const source = node.source.value;
        const quickdraw = QUICKDRAW.test(source);
        if (source !== TANSTACK && !quickdraw) {
          return;
        }
        for (const specifier of node.specifiers) {
          if (specifier.type === "ImportNamespaceSpecifier" && !quickdraw) {
            namespaces.add(specifier.local.name);
          } else if (specifier.type === "ImportSpecifier") {
            const name = importedName(specifier);
            if (!quickdraw && HOOKS.has(name)) {
              hooks.set(specifier.local.name, name);
            } else if (quickdraw && HELPERS.has(name)) {
              helpers.add(specifier.local.name);
            }
          }
        }
      },
      CallExpression(node) {
        const hook = hookOf(node.callee);
        if (hook !== undefined && node.arguments.some(fetchesByHand)) {
          context.report({ node, messageId: "untypedClient", data: { hook } });
        }
      },
    };
  },
};
