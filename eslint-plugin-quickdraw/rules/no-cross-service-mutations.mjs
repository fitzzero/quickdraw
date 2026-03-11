const MUTATION_METHODS = new Set(["create", "update", "delete"])

/**
 * Extract the service directory name from a file path.
 * e.g. "/app/services/cloud-build/index.ts" → "cloud-build"
 *      "/app/services/task/helpers.ts" → "task"
 */
function getServiceDirName(filename) {
  const match = filename.match(/services\/([^/]+)\//)
  return match ? match[1] : null
}

/**
 * Convert a kebab-case or snake_case directory name to camelCase
 * to match Prisma model names.
 * e.g. "cloud-build" → "cloudBuild", "task" → "task"
 */
function dirNameToModelName(dirName) {
  return dirName.replace(/[-_](\w)/g, (_, c) => c.toUpperCase())
}

/** @type {import('eslint').Rule.RuleModule} */
export default {
  meta: {
    type: "problem",
    docs: {
      description:
        "Disallow Prisma mutations on models not owned by the current service. " +
        "Services should route mutations through the owning service, not bypass it with direct Prisma calls.",
    },
    messages: {
      useBaseService:
        "Use this.{{ method }}() from BaseService instead of this.prisma.{{ model }}.{{ method }}(). " +
        "BaseService methods auto-emit updates to subscribers.",
      crossServiceMutation:
        "Direct mutation on '{{ model }}' is not owned by this service. " +
        "Route through the owning service instead of this.prisma.{{ model }}.{{ method }}().",
    },
    schema: [
      {
        type: "object",
        properties: {
          allowedModels: {
            type: "object",
            description:
              "Map of service directory name → array of foreign model names that are allowed. " +
              'e.g. { "task": ["chat"], "project": ["agent", "projectAgent"] }',
            additionalProperties: {
              type: "array",
              items: { type: "string" },
            },
          },
        },
        additionalProperties: false,
      },
    ],
  },
  create(context) {
    const filename = context.filename || context.getFilename()
    const serviceDirName = getServiceDirName(filename)

    if (!serviceDirName) return {}

    const ownedModel = dirNameToModelName(serviceDirName)
    const isIndexFile = filename.endsWith("/index.ts") || filename.endsWith("/index.js")
    const options = context.options[0] || {}
    const allowedModels = options.allowedModels || {}
    const allowedForThisService = new Set(allowedModels[serviceDirName] || [])

    return {
      CallExpression(node) {
        const callee = node.callee
        if (callee.type !== "MemberExpression") return
        if (callee.property.type !== "Identifier") return

        const methodName = callee.property.name
        if (!MUTATION_METHODS.has(methodName)) return

        const obj = callee.object
        if (obj.type !== "MemberExpression") return

        const parentObj = obj.object
        if (parentObj.type !== "MemberExpression") return
        if (parentObj.property.type !== "Identifier") return
        if (parentObj.property.name !== "prisma") return

        if (parentObj.object.type !== "ThisExpression") return

        const modelName =
          obj.property.type === "Identifier" ? obj.property.name : "model"

        if (modelName === ownedModel) {
          if (!isIndexFile) {
            context.report({
              node,
              messageId: "useBaseService",
              data: { method: methodName, model: modelName },
            })
          }
          return
        }

        if (allowedForThisService.has(modelName)) return

        context.report({
          node,
          messageId: "crossServiceMutation",
          data: { method: methodName, model: modelName },
        })
      },
    }
  },
}
