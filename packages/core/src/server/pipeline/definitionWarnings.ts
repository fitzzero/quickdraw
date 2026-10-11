// The development warnings a dispatcher raises from its services'
// definitions alone, when it is made: `tiered-field-in-output`
// (`../emit/tieredOutputs.ts`) and `channel-without-requires`
// (`../realtime/channelWarnings.ts`); `resolver-without-reads` comes with
// the access settings (`../access/resolverReads.ts`). Each is logged once,
// or thrown by a test app made with `strictWarnings`, which then fails to
// start.

import type { DevWarnings } from "../devWarnings";
import { warnTieredOutputs } from "../emit/tieredOutputs";
import { warnChannels } from "../realtime/channelWarnings";
import type { Registry } from "../registry";

/** Raises the warnings of the services `registry` holds that their definitions alone show. */
export function warnDefinitions(registry: Registry, warnings: DevWarnings): void {
  warnTieredOutputs(registry, warnings);
  warnChannels(registry, warnings);
}
