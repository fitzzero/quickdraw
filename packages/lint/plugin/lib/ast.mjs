// Small AST helpers shared by the rules. Every rule is syntactic: oxlint's
// JS plugins see the ESTree (and TS-ESTree) shape of one file and nothing of
// its types.

const WRAPPERS = new Set([
  "ChainExpression",
  "ParenthesizedExpression",
  "TSAsExpression",
  "TSInstantiationExpression",
  "TSNonNullExpression",
  "TSSatisfiesExpression",
  "TSTypeAssertion",
]);

/** The expression inside parentheses, optional chains and type assertions. */
export function unwrap(node) {
  let current = node;
  while (current !== null && current !== undefined && WRAPPERS.has(current.type)) {
    current = current.expression;
  }
  return current;
}

/** The property name of a member expression: `a.b` and `a["b"]` give `"b"`. */
export function memberName(member) {
  const { property } = member;
  if (!member.computed && property.type === "Identifier") {
    return property.name;
  }
  if (property.type === "Literal" && typeof property.value === "string") {
    return property.value;
  }
  return undefined;
}

/** The name of an object property's or a class member's key. */
export function keyName(property) {
  const { key } = property;
  if (key === undefined || key === null) {
    return undefined;
  }
  if (!property.computed && key.type === "Identifier") {
    return key.name;
  }
  if (key.type === "Literal" && typeof key.value === "string") {
    return key.value;
  }
  return undefined;
}

/** The property of an object expression named `name`, ignoring spreads. */
export function getProperty(object, name) {
  return object.properties.find(
    (property) => property.type === "Property" && keyName(property) === name,
  );
}

/** Whether an object expression spreads another object into itself. */
export function hasSpread(object) {
  return object.properties.some((property) => property.type === "SpreadElement");
}

/**
 * The names along a member chain, from its root: `ctx.rooms.emit` gives
 * `["ctx", "rooms", "emit"]` and `this.io` gives `["this", "io"]`. Calls on the
 * way are walked through, so `io.to(room).emit` gives `["io", "to", "emit"]`.
 * A computed member without a static name ends the walk as `"[]"`; a root
 * that is neither an identifier nor `this` is left out.
 */
export function chainNames(node) {
  const names = [];
  let current = unwrap(node);
  for (;;) {
    if (current.type === "MemberExpression") {
      names.unshift(memberName(current) ?? "[]");
      current = unwrap(current.object);
    } else if (current.type === "CallExpression") {
      current = unwrap(current.callee);
    } else {
      break;
    }
  }
  if (current.type === "Identifier") {
    names.unshift(current.name);
  } else if (current.type === "ThisExpression") {
    names.unshift("this");
  }
  return names;
}

/** Whether `node` is a `defineService(contract, definition)` or `qd.defineService(...)` call. */
export function isDefineService(node) {
  if (node?.type !== "CallExpression" || node.arguments.length < 2) {
    return false;
  }
  const callee = unwrap(node.callee);
  if (callee.type === "Identifier") {
    return callee.name === "defineService";
  }
  return callee.type === "MemberExpression" && memberName(callee) === "defineService";
}

/** Whether `node` is a function. */
export function isFunction(node) {
  return (
    node.type === "ArrowFunctionExpression" ||
    node.type === "FunctionExpression" ||
    node.type === "FunctionDeclaration"
  );
}

/** A string literal's value, or a template literal's when it has no expressions. */
export function staticString(node) {
  const value = unwrap(node);
  if (value === undefined || value === null) {
    return undefined;
  }
  if (value.type === "Literal" && typeof value.value === "string") {
    return value.value;
  }
  if (value.type === "TemplateLiteral" && value.expressions.length === 0) {
    return value.quasis[0]?.value.cooked ?? undefined;
  }
  return undefined;
}

/** The leading static text of a string or template literal: its value, or its first chunk. */
export function leadingText(node) {
  const value = unwrap(node);
  if (value === undefined || value === null) {
    return undefined;
  }
  if (value.type === "Literal" && typeof value.value === "string") {
    return value.value;
  }
  if (value.type === "TemplateLiteral") {
    return value.quasis[0]?.value.cooked ?? undefined;
  }
  return undefined;
}

/** What `stringShape` writes for a part of a string it cannot know. */
export const UNKNOWN_TEXT = "\u0000";

/**
 * A string expression's text with every part it cannot know (an
 * interpolation, an operand that is not a literal) written as
 * {@link UNKNOWN_TEXT}: `${base}/qd/${s}` and `base + "/qd/" + s` both give
 * `"\0/qd/\0"`. Literals, template literals and `+` concatenations of them
 * are read; anything else is one unknown part.
 */
export function stringShape(node) {
  const value = unwrap(node);
  if (value === undefined || value === null) {
    return UNKNOWN_TEXT;
  }
  if (value.type === "Literal") {
    return typeof value.value === "string" ? value.value : UNKNOWN_TEXT;
  }
  if (value.type === "TemplateLiteral") {
    return value.quasis
      .map((quasi, index) => (index === 0 ? "" : UNKNOWN_TEXT) + (quasi.value.cooked ?? ""))
      .join("");
  }
  if (value.type === "BinaryExpression" && value.operator === "+") {
    return stringShape(value.left) + stringShape(value.right);
  }
  return UNKNOWN_TEXT;
}

/** Whether `inner` lies within `outer`'s source range. */
export function contains(outer, inner) {
  return outer.range[0] <= inner.range[0] && inner.range[1] <= outer.range[1];
}

/**
 * Calls `visit` on `root` and every node below it, using the file's visitor
 * keys. `visit` returning `false` skips the node's children.
 */
export function walk(context, root, visit) {
  const keys = context.sourceCode.visitorKeys;
  const pending = [root];
  while (pending.length > 0) {
    const node = pending.pop();
    if (visit(node) !== false) {
      pending.push(...childrenOf(node, keys[node.type] ?? []));
    }
  }
}

/** The nodes under `node`'s `keys`, in key order (an array key's items in order). */
function childrenOf(node, keys) {
  const children = [];
  for (const key of keys) {
    const child = node[key];
    for (const item of Array.isArray(child) ? child : [child]) {
      if (item !== null && typeof item === "object" && typeof item.type === "string") {
        children.push(item);
      }
    }
  }
  return children;
}

/** Whether `root` mentions an identifier named one of `names`. */
export function mentions(context, root, names) {
  let found = false;
  walk(context, root, (node) => {
    if (found) {
      return false;
    }
    if (node.type === "Identifier" && names.has(node.name)) {
      found = true;
    }
    return !found;
  });
  return found;
}

/** The variable `identifier` refers to, or `null` for a global. */
export function resolveVariable(context, identifier) {
  let scope = context.sourceCode.getScope(identifier);
  const reference = scope.references.find((candidate) => candidate.identifier === identifier);
  if (reference !== undefined) {
    return reference.resolved;
  }
  for (; scope !== null; scope = scope.upper) {
    const variable = scope.set.get(identifier.name);
    if (variable !== undefined) {
      return variable;
    }
  }
  return null;
}

/** Identifiers bound by a declaration pattern: `{ a, b: [c] }` gives `a` and `c`. */
export function patternNames(pattern, names = []) {
  if (pattern === null || pattern === undefined) {
    return names;
  }
  switch (pattern.type) {
    case "Identifier":
      names.push(pattern.name);
      break;
    case "ObjectPattern":
      for (const property of pattern.properties) {
        patternNames(property.type === "RestElement" ? property.argument : property.value, names);
      }
      break;
    case "ArrayPattern":
      for (const element of pattern.elements) {
        patternNames(element, names);
      }
      break;
    case "RestElement":
      patternNames(pattern.argument, names);
      break;
    case "AssignmentPattern":
      patternNames(pattern.left, names);
      break;
    case "TSParameterProperty":
      patternNames(pattern.parameter, names);
      break;
    default:
      break;
  }
  return names;
}
