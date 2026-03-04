import noDirectPrismaMutations from "./rules/no-direct-prisma-mutations.mjs"
import requireZodSchema from "./rules/require-zod-schema.mjs"
import noServiceMethodRecord from "./rules/no-service-method-record.mjs"
import noUnsafePayloadCast from "./rules/no-unsafe-payload-cast.mjs"

/** @type {import('eslint').ESLint.Plugin} */
export default {
  rules: {
    "no-direct-prisma-mutations": noDirectPrismaMutations,
    "require-zod-schema": requireZodSchema,
    "no-service-method-record": noServiceMethodRecord,
    "no-unsafe-payload-cast": noUnsafePayloadCast,
  },
}
