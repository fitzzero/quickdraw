// The `channel-without-requires` development warning (the 5.1 audit's
// RT-3). A channel whose contract declares no `requires` takes a message
// from every signed-in socket, about any row or room its payload names: a
// handler that relays it to a room (`ctx.rooms.emit`) lets any user reach
// that room. Delivery stays as it was; the warning asks the app to say what
// the sender must hold (`requires`), or that any signed-in user may send.
//
// When a dispatcher is made, each such channel raises the warning once:
// logged, or thrown by a test app made with `strictWarnings`, which fails
// its creation (as `resolver-without-reads` does). A service that declares
// the channel's `access` (`{ access: "authenticated", handler }` included)
// says any user it admits may send, and raises nothing.

import type { DevWarning, DevWarnings } from "../devWarnings";
import type { Registry } from "../registry";
import type { AnyService } from "../service";

/** The warnings `service` raises: one per channel without `requires` whose access it left to the default. */
export function channelWarnings(service: AnyService): DevWarning[] {
  const warnings: DevWarning[] = [];
  for (const channel of service.channels.values()) {
    if (channel.requires !== undefined || channel.accessDeclared) {
      continue;
    }
    const name = `${service.name}.${channel.name}`;
    warnings.push({
      kind: "channel-without-requires",
      service: service.name,
      subject: channel.name,
      message:
        `${name}: the channel declares no requires, so every signed-in user may send it, about any ` +
        `row or room its payload names; a handler that relays it to a room (ctx.rooms.emit) lets ` +
        `anyone reach that room. Declare what the sender must hold in the contract (requires: ` +
        `{ room: (payload) => \`project:\${payload.projectId}\` }, or { entity } / { collection, ` +
        `scope }), or, when any signed-in user may send it, say so on the service: channels: ` +
        `{ ${channel.name}: { access: "authenticated", handler } }`,
      meta: { channel: channel.name },
    });
  }
  return warnings;
}

/**
 * Raises the `channel-without-requires` warnings of every service a
 * dispatcher serves: logged once each, or thrown by a test app made with
 * `strictWarnings`, failing its creation.
 */
export function warnChannels(registry: Registry, warnings: DevWarnings): void {
  if (!warnings.enabled) {
    return;
  }
  for (const service of registry.services.values()) {
    for (const warning of channelWarnings(service)) {
      warnings.warn(warning);
    }
  }
}
