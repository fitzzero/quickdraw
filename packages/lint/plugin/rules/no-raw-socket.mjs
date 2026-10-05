// Client code talks to the server through the typed client and its live
// hooks (RFC 0003 section 11), which validate, authorize, track revisions and
// survive reconnects. This rule reports raw Socket.IO calls in client code:
// `socket.emit`, `socket.on`, `socket.once`, `socket.off` and the `*Any`
// listeners, on
//
// - a socket named `socket` or a member ending in it (`connection.socket`);
// - whatever `socket.io-client` made, under any name (finding F7.7 of the
//   quickdraw-chat review: `const raw = io(url); raw.emit("qd:call", ...)`
//   passed): the result of its `io()` or `connect()` (default, named or
//   namespace import), a `new Manager()` and the sockets its `socket()`
//   opens, followed through the variables and `this.<field>`s they are
//   assigned to in the file;
// - any receiver, for an event whose name starts with `qd:`: those are the
//   framework's own frames, which only its client sends and reads.
//
// It replaces 4.1's `no-raw-socket-emit` and `no-raw-socket-on`; their
// app-specific default exemptions are gone, and
// `allowedEvents`/`allowedPrefixes` take an app's own.

import { CLIENT_FILE_OPTIONS, TEST_FILES, inClientScope } from "../lib/files.mjs";
import {
  chainNames,
  leadingText,
  memberName,
  resolveVariable,
  staticString,
  unwrap,
} from "../lib/ast.mjs";

const METHODS = new Set([
  "emit",
  "emitWithAck",
  "send",
  "on",
  "once",
  "off",
  "onAny",
  "prependAny",
  "offAny",
  "onAnyOutgoing",
  "prependAnyOutgoing",
  "offAnyOutgoing",
]);

const CLIENT_MODULE = "socket.io-client";

/** The framework's own event names: `qd:call`, `qd:sub`, `qd:e`, ... */
const FRAMEWORK_PREFIX = "qd:";

/**
 * How the file imports `socket.io-client`: the local names of its socket
 * factories (`io`, `connect`, the default export), of `Manager`, and of a
 * namespace import.
 */
function importsOf(program) {
  const factories = new Set();
  const managers = new Set();
  const namespaces = new Set();
  for (const statement of program.body) {
    if (statement.type !== "ImportDeclaration" || statement.source.value !== CLIENT_MODULE) {
      continue;
    }
    for (const specifier of statement.specifiers) {
      const local = specifier.local.name;
      if (specifier.type === "ImportDefaultSpecifier") {
        factories.add(local);
      } else if (specifier.type === "ImportNamespaceSpecifier") {
        namespaces.add(local);
      } else {
        const imported = specifier.imported.name ?? specifier.imported.value;
        if (imported === "io" || imported === "connect" || imported === "default") {
          factories.add(local);
        } else if (imported === "Manager") {
          managers.add(local);
        }
      }
    }
  }
  return { factories, managers, namespaces };
}

/** The identifier at the root of a member and call chain: `raw` in `raw.timeout(5).emit`. */
function rootIdentifier(node) {
  let current = unwrap(node);
  for (;;) {
    if (current.type === "MemberExpression") {
      current = unwrap(current.object);
    } else if (current.type === "CallExpression") {
      current = unwrap(current.callee);
    } else {
      return current.type === "Identifier" ? current : undefined;
    }
  }
}

/** `this.<name>` as `"this.<name>"`, for a field a socket is kept in; `undefined` for anything else. */
function thisField(node) {
  const target = unwrap(node);
  if (target?.type !== "MemberExpression" || unwrap(target.object).type !== "ThisExpression") {
    return undefined;
  }
  const name = memberName(target);
  return name === undefined ? undefined : `this.${name}`;
}

/**
 * What `socket.io-client` made that the file keeps: the variables and
 * `this` fields its sockets and managers are assigned to.
 */
function createTracker(context, imports) {
  const variables = new Set();
  const fields = new Set();
  const isFactory = (callee) => {
    if (callee.type === "Identifier") {
      return imports.factories.has(callee.name);
    }
    if (callee.type !== "MemberExpression") {
      return false;
    }
    const object = unwrap(callee.object);
    const name = memberName(callee);
    return (
      object.type === "Identifier" &&
      imports.namespaces.has(object.name) &&
      (name === "io" || name === "connect" || name === "default")
    );
  };
  const isManagerClass = (callee) => {
    if (callee.type === "Identifier") {
      return imports.managers.has(callee.name);
    }
    const object = callee.type === "MemberExpression" ? unwrap(callee.object) : undefined;
    return (
      object?.type === "Identifier" &&
      imports.namespaces.has(object.name) &&
      memberName(callee) === "Manager"
    );
  };
  /** Whether `node` is something `socket.io-client` made, or a value the file keeps one in. */
  const isRaw = (node) => {
    const value = unwrap(node);
    if (value === undefined || value === null) {
      return false;
    }
    if (value.type === "CallExpression") {
      const callee = unwrap(value.callee);
      if (isFactory(callee)) {
        return true;
      }
      // A manager's `socket(nsp)`, and any call on a kept socket (`raw.timeout(5000)`).
      return callee.type === "MemberExpression" && isRaw(callee.object);
    }
    if (value.type === "NewExpression") {
      return isManagerClass(unwrap(value.callee));
    }
    if (value.type === "Identifier") {
      return variables.has(resolveVariable(context, value));
    }
    const field = thisField(value);
    return field !== undefined && fields.has(field);
  };
  return {
    isRaw,
    /** Keeps `target` (a declared or assigned variable, or a `this` field) when `value` is raw. */
    assign(target, value) {
      if (!isRaw(value)) {
        return;
      }
      const field = thisField(target);
      if (field !== undefined) {
        fields.add(field);
        return;
      }
      const name = unwrap(target);
      const variable = name?.type === "Identifier" ? resolveVariable(context, name) : null;
      if (variable !== null) {
        variables.add(variable);
      }
    },
    /** Whether a call's receiver is a socket or manager the file keeps. */
    receives(object) {
      if (isRaw(object)) {
        return true;
      }
      const root = rootIdentifier(object);
      return root !== undefined && variables.has(resolveVariable(context, root));
    },
  };
}

/** @type {import('eslint').Rule.RuleModule} */
export default {
  meta: {
    type: "problem",
    docs: {
      description:
        "Disallow raw Socket.IO calls in client code; use the typed client and its hooks.",
    },
    messages: {
      rawSocket:
        "Raw `socket.{{ method }}()` bypasses the typed client: no input or access checks on the way, no revisions, no reconnect handling. " +
        "Call methods through `qd.<service>.<method>` (`useQuery`, `useMutation`, `call`), read live data with `useEntity`, `useCollection`, `useStream` or `useEvent`, send with `useChannel`, and read the connection's state with `useQuickdraw()`.",
    },
    schema: [
      {
        type: "object",
        properties: {
          ...CLIENT_FILE_OPTIONS,
          sockets: {
            type: "array",
            items: { type: "string" },
            description: "Names a socket goes by.",
          },
          allowedEvents: {
            type: "array",
            items: { type: "string" },
            description: "Event names that may be used raw.",
          },
          allowedPrefixes: {
            type: "array",
            items: { type: "string" },
            description: "Event name prefixes that may be used raw.",
          },
        },
        additionalProperties: false,
      },
    ],
  },
  create(context) {
    const options = context.options[0] ?? {};
    if (!inClientScope(context, options, { ignore: TEST_FILES })) {
      return {};
    }
    const sockets = options.sockets ?? ["socket"];
    const allowedEvents = new Set(options.allowedEvents ?? []);
    const allowedPrefixes = options.allowedPrefixes ?? [];
    const allowed = (event) =>
      event !== undefined &&
      (allowedEvents.has(event) || allowedPrefixes.some((prefix) => event.startsWith(prefix)));
    const tracker = createTracker(context, importsOf(context.sourceCode.ast));
    // Reported once the file is read: a socket may be assigned below the code that uses it.
    const calls = [];

    return {
      VariableDeclarator(node) {
        tracker.assign(node.id, node.init);
      },
      AssignmentExpression(node) {
        if (node.operator === "=") {
          tracker.assign(node.left, node.right);
        }
      },
      CallExpression(node) {
        const callee = unwrap(node.callee);
        const method = callee.type === "MemberExpression" ? memberName(callee) : undefined;
        if (method !== undefined && METHODS.has(method)) {
          calls.push({ node, callee, method });
        }
      },
      "Program:exit"() {
        for (const { node, callee, method } of calls) {
          const event =
            node.arguments[0] === undefined ? undefined : staticString(node.arguments[0]);
          const framework = leadingText(node.arguments[0])?.startsWith(FRAMEWORK_PREFIX) === true;
          const named = chainNames(callee.object).some((name) => sockets.includes(name));
          if ((named || framework || tracker.receives(callee.object)) && !allowed(event)) {
            context.report({ node, messageId: "rawSocket", data: { method } });
          }
        }
      },
    };
  },
};
