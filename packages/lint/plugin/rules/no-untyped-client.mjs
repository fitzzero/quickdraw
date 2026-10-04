// Server data goes through the typed client: `qd.<service>.<method>.useQuery`
// and `.useMutation` share the client's keys, not-modified answers,
// invalidation coordinator and optimistic overlays (RFC 0003 section 11).
// TanStack Query used directly for other data is fine. This rule reports a
// TanStack hook imported from `@tanstack/react-query` whose `queryFn` or
// `mutationFn` reaches quickdraw by hand (a call on the typed client, such
// as `qd.task.get.call(input)`; the `call`/`callData` helpers; a `fetch` of
// `/qd/...`; a raw socket emit), or whose `queryKey` is a quickdraw key.
//
// The hooks the typed client has no equivalent for (suspense, infinite and
// parallel queries, and query options) are how such reads are written, so
// they pass when every `queryKey` comes from a quickdraw member's `key(...)`
// (alone, or spread first into a longer key) and their `queryFn` reaches
// quickdraw only through a member's `call(...)`: then they share the typed
// client's keys, and `qd.invalidate(member)` reaches them.

import { CLIENT_FILE_OPTIONS, inClientScope } from "../lib/files.mjs";
import {
  chainNames,
  keyName,
  memberName,
  staticString,
  stringShape,
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
/** Hooks with no typed client equivalent: they may read through a member's `key` and `call`. */
const KEYED_HOOKS = new Set([
  "useSuspenseQuery",
  "useSuspenseInfiniteQuery",
  "useInfiniteQuery",
  "useQueries",
  "useSuspenseQueries",
  "queryOptions",
  "infiniteQueryOptions",
  "usePrefetchQuery",
  "usePrefetchInfiniteQuery",
]);

/**
 * Whether a `fetch` argument is a URL of the HTTP transport: a `/qd/`
 * segment in a string, a template (`${API_URL}/qd/taskService/get`) or a
 * concatenation (`base + "/qd/taskService/get"`), also as `new URL(...)`'s.
 */
function fetchesQuickdraw(argument) {
  const value = unwrap(argument);
  const url =
    value?.type === "NewExpression" &&
    unwrap(value.callee).type === "Identifier" &&
    unwrap(value.callee).name === "URL"
      ? value.arguments[0]
      : value;
  return stringShape(url).includes("/qd/");
}

function importedName(specifier) {
  return specifier.imported.type === "Identifier"
    ? specifier.imported.name
    : specifier.imported.value;
}

// The rule's state for one file, `state` below: `{ context, clients, hooks,
// namespaces, helpers }`: the typed client's names, the TanStack hooks the
// file imports (local name to hook), its TanStack namespace imports, and the
// quickdraw call and key helpers it imports.

/** The TanStack hook `callee` names, if any. */
function hookOf(state, callee) {
  const node = unwrap(callee);
  if (node.type === "Identifier") {
    return state.hooks.get(node.name);
  }
  if (node.type === "MemberExpression" && state.namespaces.has(unwrap(node.object).name)) {
    const name = memberName(node);
    return HOOKS.has(name) ? name : undefined;
  }
  return undefined;
}

/** Whether an array key starts with `"qd"` or a quickdraw key helper. */
function startsQuickdrawKey(state, array) {
  const head = array.elements[0];
  const first = head === null || head === undefined ? undefined : unwrap(head);
  return (
    first !== undefined &&
    (staticString(first) === "qd" || (first.type === "Identifier" && state.helpers.has(first.name)))
  );
}

/** Whether `value` is a quickdraw key: `["qd", ...]`, a key helper's, or a typed client member's. */
function isQuickdrawKey(state, value) {
  const node = unwrap(value);
  if (node.type === "ArrayExpression") {
    return startsQuickdrawKey(state, node);
  }
  if (node.type !== "CallExpression") {
    return false;
  }
  const callee = unwrap(node.callee);
  return (
    (callee.type === "Identifier" && state.helpers.has(callee.name)) ||
    (callee.type === "MemberExpression" && state.clients.has(chainNames(callee)[0]))
  );
}

/** Whether a call reaches quickdraw by hand: the typed client, a call helper, `/qd/`, a socket emit. */
function reachesQuickdraw(state, call) {
  const callee = unwrap(call.callee);
  if (callee.type === "Identifier") {
    return (
      state.helpers.has(callee.name) ||
      (callee.name === "fetch" && fetchesQuickdraw(call.arguments[0]))
    );
  }
  if (callee.type !== "MemberExpression") {
    return false;
  }
  const names = chainNames(callee);
  return (
    state.clients.has(names[0]) || (SOCKET_EMITS.has(names.at(-1)) && names.includes("socket"))
  );
}

/** Whether `value` calls a typed client member's `method`: `qd.task.get.key(input)`. */
function isMemberCall(state, value, method) {
  const node = unwrap(value);
  if (node?.type !== "CallExpression") {
    return false;
  }
  const callee = unwrap(node.callee);
  if (callee.type !== "MemberExpression" || memberName(callee) !== method) {
    return false;
  }
  const names = chainNames(callee);
  return state.clients.has(names[0]) && names.length >= 4;
}

/** A member's key, alone or spread first into a longer key: `[...qd.task.list.key(input), "pages"]`. */
function isMemberKey(state, value) {
  const node = unwrap(value);
  if (node.type === "ArrayExpression" && node.elements[0]?.type === "SpreadElement") {
    return isMemberCall(state, node.elements[0].argument, "key");
  }
  return isMemberCall(state, node, "key");
}

/** Whether a function reaches quickdraw other than through a member's `call(...)`. */
function callsBesidesMembers(state, fn) {
  let found = false;
  walk(state.context, fn, (inner) => {
    if (
      inner.type === "CallExpression" &&
      reachesQuickdraw(state, inner) &&
      !isMemberCall(state, inner, "call")
    ) {
      found = true;
    }
    return !found;
  });
  return found;
}

/**
 * Whether a keyed hook's argument reads through typed client members only:
 * every `queryKey` a member's key, and every call reaching quickdraw in a
 * `queryFn` a member's `call(...)`; no `mutationFn`.
 */
function readsThroughMembers(state, argument) {
  let keys = 0;
  let byHand = false;
  walk(state.context, argument, (node) => {
    if (byHand || node.type !== "Property") {
      return !byHand;
    }
    const name = keyName(node);
    if (name === "queryKey") {
      keys += 1;
      byHand = !isMemberKey(state, node.value);
    } else if (name === "mutationFn") {
      byHand = true;
    } else if (name === "queryFn") {
      byHand = callsBesidesMembers(state, node.value);
    }
    return !byHand;
  });
  return keys > 0 && !byHand;
}

/** Whether a function reaches quickdraw by hand anywhere. */
function callsQuickdraw(state, fn) {
  let found = false;
  walk(state.context, fn, (inner) => {
    if (inner.type === "CallExpression" && reachesQuickdraw(state, inner)) {
      found = true;
    }
    return !found;
  });
  return found;
}

/** Whether a hook's argument fetches quickdraw data by hand: a quickdraw key, or a `queryFn`/`mutationFn` that reaches it. */
function fetchesByHand(state, argument) {
  let found = false;
  walk(state.context, argument, (node) => {
    if (found || node.type !== "Property") {
      return !found;
    }
    const name = keyName(node);
    if (name === "queryKey") {
      found = isQuickdrawKey(state, node.value);
    } else if (name === "queryFn" || name === "mutationFn") {
      found = callsQuickdraw(state, node.value);
    }
    return !found;
  });
  return found;
}

/** Remembers what an import from TanStack Query or quickdraw brings in. */
function collectImports(state, node) {
  const source = node.source.value;
  const quickdraw = QUICKDRAW.test(source);
  if (source !== TANSTACK && !quickdraw) {
    return;
  }
  for (const specifier of node.specifiers) {
    if (specifier.type === "ImportNamespaceSpecifier" && !quickdraw) {
      state.namespaces.add(specifier.local.name);
    } else if (specifier.type === "ImportSpecifier") {
      const name = importedName(specifier);
      if (!quickdraw && HOOKS.has(name)) {
        state.hooks.set(specifier.local.name, name);
      } else if (quickdraw && HELPERS.has(name)) {
        state.helpers.add(specifier.local.name);
      }
    }
  }
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
        "Use the method's own hook: `qd.<service>.<method>.useQuery(input)` or `.useMutation()`; for a hook it has no equivalent of, key it with `qd.<service>.<method>.key(input)` and fetch with `.call(input)`.",
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
    const state = {
      context,
      clients: new Set(options.clients ?? ["qd"]),
      hooks: new Map(),
      namespaces: new Set(),
      helpers: new Set(),
    };
    return {
      ImportDeclaration: (node) => collectImports(state, node),
      CallExpression(node) {
        const hook = hookOf(state, node.callee);
        if (hook === undefined || !node.arguments.some((arg) => fetchesByHand(state, arg))) {
          return;
        }
        if (
          KEYED_HOOKS.has(hook) &&
          node.arguments.every((arg) => readsThroughMembers(state, arg))
        ) {
          return;
        }
        context.report({ node, messageId: "untypedClient", data: { hook } });
      },
    };
  },
};
