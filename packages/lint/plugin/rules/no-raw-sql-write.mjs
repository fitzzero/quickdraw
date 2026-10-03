// Raw SQL is invisible to the tracked client (RFC 0003 section 5.2), so a
// raw write must say which rows it changed with `ctx.touch(model, ids)`. This
// rule reports `$executeRaw` and `$executeRawUnsafe`, and `$queryRaw` and
// `$queryRawUnsafe` whose SQL starts with a write statement, unless a
// function around the call also touches (`ctx.touch(...)`, a destructured
// `touch(...)`, or `qd.collections.reset(...)` from a job).

import { FILE_OPTIONS, SERVER_FILES, TEST_FILES, inScope } from "../lib/files.mjs";
import { chainNames, contains, isFunction, leadingText, memberName, unwrap } from "../lib/ast.mjs";

const EXECUTE = new Set(["$executeRaw", "$executeRawUnsafe"]);
const QUERY = new Set(["$queryRaw", "$queryRawUnsafe"]);
const WRITE_SQL =
  /^\s*(?:(?:--[^\n]*\n|\/\*[\s\S]*?\*\/)\s*)*(?:insert|update|delete|merge|truncate)\b/i;

/** The raw method `callee` names (`db.$executeRaw` gives `$executeRaw`). */
function rawMethod(callee) {
  const node = unwrap(callee);
  if (node.type !== "MemberExpression") {
    return undefined;
  }
  const name = memberName(node);
  return name !== undefined && (EXECUTE.has(name) || QUERY.has(name)) ? name : undefined;
}

/** The leading SQL text of a raw call's argument: a string, a template, or `Prisma.sql`/`Prisma.raw`. */
function sqlText(argument) {
  const node = unwrap(argument);
  if (node === undefined) {
    return undefined;
  }
  if (node.type === "TaggedTemplateExpression") {
    return leadingText(node.quasi);
  }
  if (node.type === "CallExpression") {
    return node.arguments[0] === undefined ? undefined : sqlText(node.arguments[0]);
  }
  return leadingText(node);
}

function isWrite(method, sql) {
  return EXECUTE.has(method) || (sql !== undefined && WRITE_SQL.test(sql));
}

/** Whether `call` records rows: `ctx.touch(...)`, `touch(...)` or `….collections.reset(...)`. */
function isTouch(call) {
  const callee = unwrap(call.callee);
  if (callee.type === "Identifier") {
    return callee.name === "touch";
  }
  if (callee.type !== "MemberExpression") {
    return false;
  }
  if (memberName(callee) === "touch") {
    return true;
  }
  const names = chainNames(callee);
  return names.at(-1) === "reset" && names.at(-2) === "collections";
}

/** @type {import('eslint').Rule.RuleModule} */
export default {
  meta: {
    type: "problem",
    docs: {
      description:
        "Require `ctx.touch(model, ids)` next to a raw SQL write, which the tracked client cannot see.",
    },
    messages: {
      rawWrite:
        "`{{ method }}` writes rows the tracked client cannot see, so their subscribers hear nothing. " +
        "Record them with `ctx.touch(model, ids)` in the same function (`{ removed: true }` for deleted rows; `qd.collections.reset(...)` from a job), or write through `db.<model>`.",
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
    if (!inScope(context, options, { files: SERVER_FILES, ignore: TEST_FILES })) {
      return {};
    }
    const writes = [];
    const touches = [];

    const recordedAround = (node) => {
      for (const ancestor of context.sourceCode.getAncestors(node).toReversed()) {
        if (isFunction(ancestor) && touches.some((touch) => contains(ancestor, touch))) {
          return true;
        }
      }
      return false;
    };

    return {
      TaggedTemplateExpression(node) {
        const method = rawMethod(node.tag);
        if (method !== undefined && isWrite(method, leadingText(node.quasi))) {
          writes.push({ node, method });
        }
      },
      CallExpression(node) {
        const method = rawMethod(node.callee);
        if (method === undefined) {
          if (isTouch(node)) {
            touches.push(node);
          }
          return;
        }
        if (
          isWrite(method, node.arguments[0] === undefined ? undefined : sqlText(node.arguments[0]))
        ) {
          writes.push({ node, method });
        }
      },
      "Program:exit"() {
        for (const { node, method } of writes) {
          if (!recordedAround(node)) {
            context.report({ node, messageId: "rawWrite", data: { method } });
          }
        }
      },
    };
  },
};
