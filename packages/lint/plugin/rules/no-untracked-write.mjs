// A write is seen by subscribers only when it goes through the tracked
// client (RFC 0003 section 5): the handler's `db` argument, or in a job,
// script or webhook the app's `trackPrisma(...)` client inside `qd.run`.
// This rule keeps the untracked Prisma client out of services, jobs and
// routes: importing it from the app's database package, and writing through
// a client named `prisma`. Reads through it are left alone, and so is a
// write through a binding or class member declared with quickdraw's tracked
// client type (`prisma: Tracked<Db>`, `{ prisma }: { prisma: Tracked<Db> }`,
// `private readonly prisma: Tracked<Db>`), whatever its name: the compiler
// refuses the untracked client there. The type counts when the file imports
// it from `@fitzzero/quickdraw-core` or `@fitzzero/quickdraw-core/prisma`,
// under any name; an app's own type named `Tracked` does not.

import { FILE_OPTIONS, SERVER_FILES, TEST_FILES, inScope, matchesAny } from "../lib/files.mjs";
import { WRITE_METHODS, declaredTracked, modelCall } from "../lib/prisma.mjs";

const DEFAULT_MODULES = ["@project/db", "@prisma/client", "**/generated/prisma/client*"];
const DEFAULT_CLIENTS = ["prisma"];

/** The name an import specifier brings in from its module. */
function importedName(specifier) {
  const { imported } = specifier;
  return imported.type === "Identifier" ? imported.name : imported.value;
}

/** @type {import('eslint').Rule.RuleModule} */
export default {
  meta: {
    type: "problem",
    docs: {
      description:
        "Disallow the untracked database client in services, jobs and routes: writes through it send no live updates.",
    },
    messages: {
      importClient:
        '"{{ name }}" from "{{ source }}" is the untracked database client: writes through it send no live updates. ' +
        "Use the handler's `db` argument; in a job, script or webhook, import the tracked client (`trackPrisma(...)`) and wrap its writes in `qd.run(() => ...)`.",
      untrackedWrite:
        "`{{ client }}.{{ model }}.{{ method }}()` writes through the untracked client, so subscribers never see this change. " +
        "Write through the handler's `db` argument, or through the tracked client inside `qd.run(() => ...)`. " +
        "A parameter, variable or class member given the tracked client says so with its type, whatever its name: `Tracked<Db>`, imported from `@fitzzero/quickdraw-core/prisma`.",
    },
    schema: [
      {
        type: "object",
        properties: {
          ...FILE_OPTIONS,
          modules: {
            type: "array",
            items: { type: "string" },
            description: "Module specifiers (globs) that export the untracked client.",
          },
          clients: {
            type: "array",
            items: { type: "string" },
            description:
              "Names the untracked client goes by; one declared with a tracked client's type (`Tracked<Db>`) is not it.",
          },
        },
        additionalProperties: false,
      },
    ],
  },
  create(context) {
    const options = context.options[0] ?? {};
    if (!inScope(context, options, { files: SERVER_FILES, ignore: TEST_FILES })) {
      return {};
    }
    const modules = options.modules ?? DEFAULT_MODULES;
    const clients = options.clients ?? DEFAULT_CLIENTS;
    const clientImports = new Set([...clients, "PrismaClient"]);

    return {
      ImportDeclaration(node) {
        const source = node.source.value;
        if (node.importKind === "type" || !matchesAny(source, modules)) {
          return;
        }
        for (const specifier of node.specifiers) {
          if (specifier.type !== "ImportSpecifier" || specifier.importKind === "type") {
            continue;
          }
          const name = importedName(specifier);
          if (clientImports.has(name)) {
            context.report({ node: specifier, messageId: "importClient", data: { name, source } });
          }
        }
      },
      CallExpression(node) {
        const call = modelCall(node, clients);
        if (
          call === undefined ||
          !WRITE_METHODS.has(call.method) ||
          declaredTracked(context, call.receiver)
        ) {
          return;
        }
        context.report({
          node,
          messageId: "untrackedWrite",
          data: { client: call.client, model: call.model, method: call.method },
        });
      },
    };
  },
};
