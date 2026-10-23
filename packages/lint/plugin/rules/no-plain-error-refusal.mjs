// A socket's handshake whose `authenticate` threw anything but a
// `QuickdrawError` is refused `INTERNAL`, and an HTTP call is answered
// `INTERNAL`: the server's own failure (its session store down, say), which
// the quickdraw client retries, keeping the user and what it cached. So
// credentials refused with a plain `Error` never sign the user out: the
// client retries them for ever. The MCP registry answers its `principal`
// hook the same way: a plain `Error` thrown for a bad token is answered
// `INTERNAL`, so the agent is never told its token is refused. This rule
// reports a throw of a built-in error (`new Error(...)`, `TypeError(...)`,
// with or without `new`) in a function given as `auth.authenticate` to
// `createServer` (`qd.createServer` too) or `createHttpRouter`, as
// `loadPrincipal` to `socketAuth`, which passes on what that throws, or as
// `principal` to `createMcpRegistry`: the function written there, or the one
// this file declares under the name given (a `function`, or a `const`), and
// an `auth` or options object written there or held by a `const` of this
// file.
//
// A throw inside a nested function, a `try` block with a `catch`, or a
// `catch` clause (a failure handled there, or passed on as the server's own)
// is left alone, and so is an error class of the app's, which the rule
// cannot see into. A function from another module is not seen either; the
// server warns at runtime for those (`[quickdraw:authenticate-threw]`, and
// `[quickdraw:mcp-principal-threw]` for a registry's hook).

import { getProperty, isFunction, memberName, resolveVariable, unwrap, walk } from "../lib/ast.mjs";
import { FILE_OPTIONS, TEST_FILES, inScope } from "../lib/files.mjs";

/** The built-in error constructors: a throw of one is no `QuickdrawError`. */
const BUILT_IN_ERRORS = new Set([
  "Error",
  "TypeError",
  "RangeError",
  "ReferenceError",
  "SyntaxError",
  "EvalError",
  "URIError",
  "AggregateError",
]);

/** The calls whose options take an `auth` with an `authenticate`. */
const SERVERS = new Set(["createServer", "createHttpRouter"]);

/** The name a call's callee ends in: `createServer` for `createServer(...)` and `qd.createServer(...)`. */
function calleeName(call) {
  const callee = unwrap(call.callee);
  if (callee.type === "Identifier") {
    return callee.name;
  }
  return callee.type === "MemberExpression" ? memberName(callee) : undefined;
}

/** What a name stands for where this file declares it: a function declaration, or a `const`'s value. */
function declared(context, identifier) {
  const variable = resolveVariable(context, identifier);
  const definition = variable?.defs.length === 1 ? variable.defs[0] : undefined;
  if (definition?.type === "FunctionName") {
    return definition.node;
  }
  const declarator = definition?.type === "Variable" ? definition.node : undefined;
  return definition?.parent?.kind === "const" &&
    declarator?.id.type === "Identifier" &&
    declarator.init !== null
    ? unwrap(declarator.init)
    : undefined;
}

/** `node` as an object literal: written there, or held by the `const` of this file it names. */
function objectOf(context, node) {
  const value = unwrap(node);
  const object = value?.type === "Identifier" ? declared(context, value) : value;
  return object?.type === "ObjectExpression" ? object : undefined;
}

/** The function `object`'s `name` gives: written there (a method too), or the one of this file it names. */
function functionOf(context, object, name) {
  const property = object === undefined ? undefined : getProperty(object, name);
  const value = property === undefined ? undefined : unwrap(property.value);
  const fn = value?.type === "Identifier" ? declared(context, value) : value;
  return fn !== undefined && fn !== null && isFunction(fn) ? fn : undefined;
}

/** Whether a `throw` throws a built-in error: `throw new Error(...)`, `throw TypeError(...)`. */
function throwsBuiltIn(statement) {
  const argument = unwrap(statement.argument);
  const made =
    argument?.type === "NewExpression" || argument?.type === "CallExpression"
      ? unwrap(argument.callee)
      : undefined;
  return made?.type === "Identifier" && BUILT_IN_ERRORS.has(made.name);
}

/**
 * The throws of a built-in error that `fn` makes itself: none inside a
 * nested function, a `try` block with a `catch`, or a `catch` clause.
 */
function plainThrows(context, fn) {
  const found = [];
  const visit = (node) => {
    if (isFunction(node)) {
      return false;
    }
    if (node.type === "TryStatement" && node.handler !== null) {
      if (node.finalizer !== null) {
        walk(context, node.finalizer, visit);
      }
      return false;
    }
    if (node.type === "ThrowStatement" && throwsBuiltIn(node)) {
      found.push(node);
    }
    return true;
  };
  walk(context, fn.body, visit);
  return found;
}

/** The function a call hands its credentials to, and which it is: `[fn, messageId]`, or `undefined`. */
function checkedFunction(context, call) {
  const name = calleeName(call);
  const options = objectOf(context, call.arguments[0]);
  if (options === undefined) {
    return undefined;
  }
  if (SERVERS.has(name)) {
    const auth = objectOf(context, getProperty(options, "auth")?.value);
    const fn = functionOf(context, auth, "authenticate");
    return fn === undefined ? undefined : [fn, "authenticate"];
  }
  if (name === "socketAuth") {
    const fn = functionOf(context, options, "loadPrincipal");
    return fn === undefined ? undefined : [fn, "loadPrincipal"];
  }
  if (name === "createMcpRegistry") {
    const fn = functionOf(context, options, "principal");
    return fn === undefined ? undefined : [fn, "principal"];
  }
  return undefined;
}

/** @type {import('eslint').Rule.RuleModule} */
export default {
  meta: {
    type: "problem",
    docs: {
      description:
        "Disallow refusing credentials with a plain `Error` in `authenticate`, `socketAuth`'s `loadPrincipal` or an MCP registry's `principal` hook, which reads as an outage the client retries for ever: throw `QuickdrawError(\"UNAUTHENTICATED\")`.",
    },
    messages: {
      authenticate:
        "`authenticate` throws a plain error here, which quickdraw takes for the server's own failure (its session store down, say): " +
        "a socket's handshake is refused `INTERNAL` and the client keeps the user and connects again, for ever if the credentials are bad, and an HTTP call is answered `INTERNAL`. " +
        'To refuse the credentials, `throw new QuickdrawError("UNAUTHENTICATED", ...)`, which signs the client out; to let the caller in anonymously, return `null`.',
      loadPrincipal:
        "`loadPrincipal` throws a plain error here, which `socketAuth` passes on as the server's own failure: " +
        "a socket's handshake is refused `INTERNAL` and the client keeps the user and connects again, for ever if the session's user is gone, and an HTTP call is answered `INTERNAL`. " +
        'To refuse the session\'s user, return `null` (or `throw new QuickdrawError("UNAUTHENTICATED", ...)`), which signs the client out.',
      principal:
        "The MCP registry's `principal` hook throws a plain error here, which the registry takes for the server's own failure (its token store down, say): " +
        "the call is answered `INTERNAL` (500 over HTTP), so the agent is never told its token is refused, and may keep sending it. " +
        'To refuse the token, `throw new QuickdrawError("UNAUTHENTICATED", ...)`; to let the caller in anonymously, return `null`.',
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
    const options = context.options[0] ?? {};
    if (!inScope(context, options, { ignore: TEST_FILES })) {
      return {};
    }
    // A function given to two calls (`createServer` and `createHttpRouter`) is reported once.
    const reported = new Set();
    return {
      CallExpression(node) {
        const checked = checkedFunction(context, node);
        if (checked === undefined) {
          return;
        }
        const [fn, messageId] = checked;
        for (const statement of plainThrows(context, fn)) {
          if (!reported.has(statement)) {
            reported.add(statement);
            context.report({ node: statement, messageId });
          }
        }
      },
    };
  },
};
