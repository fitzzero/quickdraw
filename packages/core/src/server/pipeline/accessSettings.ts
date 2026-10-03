// The dispatcher's `access` option, resolved (RFC 0003 section 4): the policy
// engine over the services' policies, and the access engine that decides each
// method's form, the app's own or the basic engine with the policies' row
// access.

import type { Logger } from "../../contract/logger";
import type { PolicyEngine } from "../access/api";
import { createBasicAccessEngine } from "../access/basicEngine";
import { createPolicyEngine, type AccessOptions } from "../access/engine";
import type { AccessEngine } from "../access/types";
import type { Registry } from "../registry";
import type { StorageAdapter } from "../storage";

export type { AccessEngine, AccessOptions, PolicyEngine };

function isAccessEngine(value: unknown): value is AccessEngine {
  return (
    typeof value === "object" &&
    value !== null &&
    typeof (value as Partial<AccessEngine>).authorize === "function"
  );
}

/** The policy engine, and the access engine: the app's own, or the basic engine with the policies' row access. */
export function resolveAccess(
  access: AccessEngine | AccessOptions | undefined,
  registry: Registry,
  storage: StorageAdapter | undefined,
  logger: Logger,
): { access: AccessEngine; policies: PolicyEngine } {
  if (access !== undefined && (typeof access !== "object" || access === null)) {
    throw new TypeError("createDispatcher: access must be an access engine or { cacheMs }");
  }
  const engine = isAccessEngine(access) ? access : undefined;
  const accessOptions: AccessOptions = isAccessEngine(access) ? {} : (access ?? {});
  const policies = createPolicyEngine({
    registry,
    storage,
    logger,
    cacheMs: accessOptions.cacheMs,
  });
  return { access: engine ?? createBasicAccessEngine({ rows: policies.rows }), policies };
}
