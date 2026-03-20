import noCrossServiceMutations from "./rules/no-cross-service-mutations.mjs"
import requireZodSchema from "./rules/require-zod-schema.mjs"
import noServiceMethodRecord from "./rules/no-service-method-record.mjs"
import noUnsafePayloadCast from "./rules/no-unsafe-payload-cast.mjs"
import noRawSocketOn from "./rules/no-raw-socket-on.mjs"
import noRawSocketEmit from "./rules/no-raw-socket-emit.mjs"

/** @type {import('eslint').ESLint.Plugin} */
export default {
  rules: {
    "no-cross-service-mutations": noCrossServiceMutations,
    "require-zod-schema": requireZodSchema,
    "no-service-method-record": noServiceMethodRecord,
    "no-unsafe-payload-cast": noUnsafePayloadCast,
    "no-raw-socket-on": noRawSocketOn,
    "no-raw-socket-emit": noRawSocketEmit,
  },
}
