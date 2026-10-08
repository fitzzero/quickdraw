// The `resolver-without-reads` development warning (finding R1.1 of the
// 5.0.0 review). A resolver's levels come from app code, so the engine knows
// what they depend on only from its `reads` (`policies/resolver.ts`). With
// none, no tracked write re-checks what the policy authorized: a user removed
// from a table the resolver reads keeps the live rows, collection scopes and
// change topics it let them subscribe to, and keeps receiving their updates.
//
// When a dispatcher is made, each service with a model whose policy is a
// resolver without `reads`, alone or in `anyOf`, raises the warning once:
// logged, or thrown by a test app made with `strictWarnings`, which fails its
// creation (as `tiered-field-in-output` does). `reads: "none"` says the
// levels depend on nothing a tracked write changes, and raises nothing.

import type { DevWarning, DevWarnings } from "../devWarnings";
import type { Registry } from "../registry";
import type { AnyService } from "../service";
import { anyOfPolicies } from "./policies/anyOf";
import { declaresNoReads } from "./policies/resolver";
import type { AnyAccessPolicy } from "./policy";

/** True when `policy` is, or combines in `anyOf`, a resolver made without `reads`. */
function hasUndeclaredResolver(policy: AnyAccessPolicy): boolean {
  return declaresNoReads(policy) || (anyOfPolicies(policy)?.some(hasUndeclaredResolver) ?? false);
}

/** The warning `service` raises: one when its policy has a resolver without `reads`. */
export function resolverReadsWarnings(service: AnyService): DevWarning[] {
  const { access, model } = service;
  if (access === undefined || model === undefined || !hasUndeclaredResolver(access)) {
    return [];
  }
  return [
    {
      kind: "resolver-without-reads",
      service: service.name,
      message:
        `${service.name}: its access policy uses a resolver that declares no reads, so no tracked write ` +
        `re-checks the levels it gives: a live row, collection scope or change topic it authorized stays ` +
        `open after the user loses access. Declare what the levels depend on, resolver({ levelsFor, ` +
        `reads: { columns, memberships } }) (columns of the ${model} model, membership tables as ` +
        `members() takes them), or reads: "none" when nothing a tracked write changes can change them`,
      meta: { model },
    },
  ];
}

/**
 * Raises the `resolver-without-reads` warnings of every service a
 * dispatcher serves: logged once each, or thrown by a test app made with
 * `strictWarnings`, failing its creation.
 */
export function warnResolverReads(registry: Registry, warnings: DevWarnings): void {
  if (!warnings.enabled) {
    return;
  }
  for (const service of registry.services.values()) {
    for (const warning of resolverReadsWarnings(service)) {
      warnings.warn(warning);
    }
  }
}
