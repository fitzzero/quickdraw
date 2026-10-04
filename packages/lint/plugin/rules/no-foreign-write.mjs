// A service writes its own model and the models it lists in `writes`
// (RFC 0003 sections 3 and 14). This rule reads both from the
// `defineService(contract, { model, writes })` call a write sits in, so it
// needs no map of owners: a write to any other model through `db` (or `tx`)
// is reported. A write outside a `defineService` call, or in one whose
// `model` or `writes` is not written out literally, is not checked.

import { getProperty, hasSpread, memberName, staticString, unwrap } from "../lib/ast.mjs";
import { CLIENTS_OPTION, TRACKED_CLIENTS, WRITE_METHODS, modelCall } from "../lib/prisma.mjs";

const UNKNOWN = Symbol("unknown");

function isDefineService(node) {
  if (node?.type !== "CallExpression" || node.arguments.length < 2) {
    return false;
  }
  const callee = unwrap(node.callee);
  if (callee.type === "Identifier") {
    return callee.name === "defineService";
  }
  return callee.type === "MemberExpression" && memberName(callee) === "defineService";
}

/** The definition's `model` (or `undefined` when it has none) and `writes`, or UNKNOWN. */
function readOwnership(definition) {
  const modelProperty = getProperty(definition, "model");
  const writesProperty = getProperty(definition, "writes");
  if (hasSpread(definition) && (modelProperty === undefined || writesProperty === undefined)) {
    return UNKNOWN;
  }
  let model;
  if (modelProperty !== undefined) {
    model = staticString(modelProperty.value);
    if (model === undefined) {
      return UNKNOWN;
    }
  }
  const writes = new Set();
  if (writesProperty !== undefined) {
    const list = unwrap(writesProperty.value);
    if (list.type !== "ArrayExpression") {
      return UNKNOWN;
    }
    for (const element of list.elements) {
      const name = element === null ? undefined : staticString(element);
      if (name === undefined) {
        return UNKNOWN;
      }
      writes.add(name);
    }
  }
  return { model, writes };
}

/** The ownership of the `defineService` call whose definition holds `node`. */
function enclosingService(node, cache) {
  let child = node;
  for (let current = node.parent; current !== null && current !== undefined; ) {
    if (isDefineService(current) && current.arguments[1] === child) {
      const definition = unwrap(child);
      if (definition.type !== "ObjectExpression") {
        return UNKNOWN;
      }
      if (!cache.has(definition)) {
        cache.set(definition, readOwnership(definition));
      }
      return cache.get(definition);
    }
    child = current;
    current = current.parent;
  }
  return UNKNOWN;
}

/** @type {import('eslint').Rule.RuleModule} */
export default {
  meta: {
    type: "problem",
    docs: {
      description:
        "Disallow writing a model the enclosing service neither owns (`model`) nor lists in `writes`.",
    },
    messages: {
      foreignWrite:
        "`{{ client }}.{{ model }}.{{ method }}()` writes `{{ model }}`, which is not this service's model ({{ own }}) and not in its `writes`. " +
        'Add "{{ model }}" to `writes` if this service is meant to change those rows, or ask the service that owns them (`ctx.services`).',
    },
    schema: [
      {
        type: "object",
        properties: { clients: CLIENTS_OPTION },
        additionalProperties: false,
      },
    ],
  },
  create(context) {
    const clients = context.options[0]?.clients ?? TRACKED_CLIENTS;
    const cache = new WeakMap();
    return {
      CallExpression(node) {
        const call = modelCall(node, clients);
        if (call === undefined || !WRITE_METHODS.has(call.method)) {
          return;
        }
        const service = enclosingService(node, cache);
        if (service === UNKNOWN || service.model === call.model || service.writes.has(call.model)) {
          return;
        }
        context.report({
          node,
          messageId: "foreignWrite",
          data: {
            client: call.client,
            model: call.model,
            method: call.method,
            own: service.model === undefined ? "it declares none" : `"${service.model}"`,
          },
        });
      },
    };
  },
};
