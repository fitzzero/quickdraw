// A service's public surface is its index; its other files are internals.
// Importing them from another service couples two services at a layer
// nothing documents or reviews (RFC 0003 section 14). This rule reports a
// relative import, re-export or dynamic import from one service directory
// (`services/<a>/...`) into another's files other than its index. The
// `shared` directories and an allowlist of `<service>/<file>` edges per
// importing service are exempt. Ported from foundation's local rule; it also
// catches a specifier that leaves the services directory and comes back in
// (`../../services/<b>/x.js`).

import { FILE_OPTIONS, SERVICE_FILES, TEST_FILES, inScope, lintedPath } from "../lib/files.mjs";

const INDEX = /^index(?:\.[cm]?[jt]sx?)?$/;

/** The service directory a file is in: `.../services/chat/methods/send.ts` gives `chat`. */
function serviceOf(file) {
  const match = /^(?:(.*)\/)?services\/([^/]+)\/(.+)$/.exec(file);
  if (match === null) {
    return undefined;
  }
  const [, prefix = "", name, rest] = match;
  return {
    root: prefix === "" ? ["services"] : [...prefix.split("/"), "services"],
    name,
    directory: [name, ...rest.split("/").slice(0, -1)],
  };
}

/** Where a relative specifier lands inside the services directory: `[service, ...path]`, or `undefined`. */
function landing(service, specifier) {
  const segments = [...service.root, ...service.directory];
  for (const part of specifier.split("/")) {
    if (part === "" || part === ".") {
      continue;
    }
    if (part === "..") {
      if (segments.length === 0) {
        return undefined;
      }
      segments.pop();
    } else {
      segments.push(part);
    }
  }
  const inside =
    segments.length > service.root.length &&
    service.root.every((segment, index) => segments[index] === segment);
  return inside ? segments.slice(service.root.length) : undefined;
}

/** @type {import('eslint').Rule.RuleModule} */
export default {
  meta: {
    type: "problem",
    docs: {
      description: "Disallow importing another service's internal files; go through its index.",
    },
    messages: {
      internalImport:
        '"{{ specifier }}" reaches into the `{{ target }}` service\'s internal files from `{{ source }}`. ' +
        "Import what `{{ target }}` exports from its index, call it through `ctx.services`, or move the shared code to a `shared` directory.",
    },
    schema: [
      {
        type: "object",
        properties: {
          ...FILE_OPTIONS,
          shared: {
            type: "array",
            items: { type: "string" },
            description: "Service directories every service may import from.",
          },
          allow: {
            type: "object",
            additionalProperties: { type: "array", items: { type: "string" } },
            description:
              'Per importing service, the `<service>/<file>` paths it may import: { "player": ["clan/queries.js"] }.',
          },
        },
        additionalProperties: false,
      },
    ],
  },
  create(context) {
    const options = context.options[0] ?? {};
    if (!inScope(context, options, { files: SERVICE_FILES, ignore: TEST_FILES })) {
      return {};
    }
    const service = serviceOf(lintedPath(context));
    if (service === undefined) {
      return {};
    }
    const shared = new Set(options.shared ?? ["shared"]);
    const allowed = new Set(options.allow?.[service.name] ?? []);

    const check = (node, source) => {
      if (
        source?.type !== "Literal" ||
        typeof source.value !== "string" ||
        !source.value.startsWith(".")
      ) {
        return;
      }
      const target = landing(service, source.value);
      if (target === undefined || target.length < 2) {
        return;
      }
      const [name, ...rest] = target;
      const file = rest.join("/");
      if (
        name === service.name ||
        shared.has(name) ||
        INDEX.test(file) ||
        allowed.has(`${name}/${file}`)
      ) {
        return;
      }
      context.report({
        node,
        messageId: "internalImport",
        data: { specifier: source.value, target: name, source: service.name },
      });
    };

    return {
      ImportDeclaration: (node) => check(node, node.source),
      ExportNamedDeclaration: (node) => check(node, node.source),
      ExportAllDeclaration: (node) => check(node, node.source),
      ImportExpression: (node) => check(node, node.source),
    };
  },
};
